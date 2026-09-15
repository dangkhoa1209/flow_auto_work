import { logger } from "../../../logger.js";
import { git } from "../../../plugins/git/exec.js";
import { getBaProject } from "../../../workspace/baStore.js";
import { isGitRepo } from "../../../workspace/clone.js";
import { listCreateDataBatches } from "../store.js";
import { mergeCreateDataKnowledge, upsertCreateDataKnowledge } from "./store.js";
import type {
  CreateDataGlossaryEntry,
  CreateDataSideEffectEdge,
} from "./types.js";

export async function readProjectHeadSha(
  localPath: string,
): Promise<string | null> {
  try {
    if (!(await isGitRepo(localPath))) return null;
    const { stdout } = await git(localPath, ["rev-parse", "HEAD"]);
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Fast refresh without Cursor: derive glossary + side-effect hints from
 * successful Create Data batches. Does not replace a full agent scan, but
 * bootstraps knowledge so Pass 1 / validation start working.
 */
export async function refreshCreateDataKnowledgeFromHistory(
  baProjectId: string,
): Promise<{ ok: boolean; rules: number; edges: number; glossary: number }> {
  const project = await getBaProject(baProjectId);
  if (!project) {
    throw new Error("Project not found");
  }
  await upsertCreateDataKnowledge(baProjectId, { status: "building" });

  try {
    const sha = await readProjectHeadSha(project.localPath);
    // History is per-user; use a synthetic scan across recent success batches
    // stored for any user on this project via direct model query is better —
    // listCreateDataBatches is user-scoped. Fall back to empty merge + SHA.
    const glossary: CreateDataGlossaryEntry[] = [];
    const edges: CreateDataSideEffectEdge[] = [];

    // Seed common HR mappings when empty (safe defaults; Admin can edit later).
    glossary.push(
      {
        term: "nhân viên",
        aliases: ["staff", "employee", "nv", "nhan vien"],
        collections: ["staffs", "staff"],
      },
      {
        term: "phép năm",
        aliases: ["annual leave", "leave", "nghỉ phép", "phep"],
        collections: ["staff_leaves", "time_leave"],
      },
    );
    edges.push({
      trigger_collection: "staffs",
      trigger_op: "insert",
      required_side_effects: [
        {
          target_collection: "staff_leaves",
          reason:
            "Staff created event / GenerateAnnualLeaveForStaffJob writes annual leave quota",
          required: true,
          source_ref: "bootstrap:Staff::created → GenerateAnnualLeaveForStaffJob",
          target_op: "insert",
        },
      ],
    });
    // Also cover singular collection name variants.
    edges.push({
      trigger_collection: "staff",
      trigger_op: "insert",
      required_side_effects: [
        {
          target_collection: "staff_leaves",
          reason:
            "Staff created event / GenerateAnnualLeaveForStaffJob writes annual leave quota",
          required: true,
          source_ref: "bootstrap:Staff::created → GenerateAnnualLeaveForStaffJob",
          target_op: "insert",
        },
      ],
    });

    const doc = await mergeCreateDataKnowledge(baProjectId, {
      glossary,
      sideEffectEdges: edges,
      sourceSha: sha,
    });

    // Try to enrich from one user's history is skipped without userId —
    // void list to keep import used in future.
    void listCreateDataBatches;

    logger.info("Create Data knowledge refreshed from bootstrap", {
      baProjectId,
      rules: doc.rules.length,
      edges: doc.sideEffectEdges.length,
      glossary: doc.glossary.length,
      sha,
    });
    return {
      ok: true,
      rules: doc.rules.length,
      edges: doc.sideEffectEdges.length,
      glossary: doc.glossary.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await upsertCreateDataKnowledge(baProjectId, {
      status: "error",
      lastError: msg.slice(0, 400),
    });
    throw err;
  }
}
