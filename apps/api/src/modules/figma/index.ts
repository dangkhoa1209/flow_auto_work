/**
 * Figma orchestration — detect links, opt-in, fetch with project PAT.
 */

import { addChatMessage, listChatMessages } from "../../db/mongo.js";
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import { jobQueue } from "../../queue.js";
import type { JobRecord } from "../../types.js";
import { resolveDevNotes } from "../../types.js";
import {
  fetchFigmaForPrompt,
  formatFigmaPromptBlock,
} from "../../plugins/figma/fetch.js";
import {
  collectFigmaRefsFromTexts,
  figmaIncludeKey,
  type FigmaRef,
} from "../../plugins/figma/refs.js";
import { getProject, getProjectSecrets } from "../../workspace/store.js";
import { requireJobRecord } from "../job/lifecycle.js";

export async function collectJobFigmaRefs(
  job: JobRecord,
  chatBodies?: string[],
): Promise<FigmaRef[]> {
  const texts: string[] = [
    job.issue?.description || "",
    resolveDevNotes(job),
    ...(job.pendingFigmaUrls || []),
  ];
  if (chatBodies?.length) {
    texts.push(...chatBodies);
  } else {
    try {
      const rows = await listChatMessages({ jobId: job.id, limit: 40 });
      texts.push(...rows.map((m) => m.body || ""));
    } catch {
      /* ignore */
    }
  }
  return collectFigmaRefsFromTexts(texts);
}

export async function detectJobFigma(jobId: string): Promise<{
  figs: Array<{
    fileKey: string;
    nodeId?: string;
    url: string;
    kind: FigmaRef["kind"];
    includeKey: string;
  }>;
  includeKeys: string[];
  hasFigmaToken: boolean;
}> {
  const job = await requireJobRecord(jobId);
  const refs = await collectJobFigmaRefs(job);
  const includeKeys = [...new Set(job.figmaIncludeKeys ?? [])].filter(Boolean);
  let hasFigmaToken = false;
  if (job.workspaceProjectId) {
    const secrets = await getProjectSecrets(job.workspaceProjectId);
    hasFigmaToken = Boolean(secrets?.figmaToken);
  }
  return {
    figs: refs.map((r) => ({
      fileKey: r.fileKey,
      nodeId: r.nodeId,
      url: r.url,
      kind: r.kind,
      includeKey: figmaIncludeKey(r),
    })),
    includeKeys,
    hasFigmaToken,
  };
}

export async function setJobFigmaInclude(
  jobId: string,
  keys: string[],
): Promise<{ ok: boolean; includeKeys: string[]; job: JobRecord }> {
  const job = await requireJobRecord(jobId);
  const refs = await collectJobFigmaRefs(job);
  const allowed = new Set(refs.map((r) => figmaIncludeKey(r)));
  const includeKeys = [
    ...new Set(
      (keys || [])
        .map((s) => String(s).trim())
        .filter((k) => k && allowed.has(k)),
    ),
  ];
  job.figmaIncludeKeys = includeKeys.length ? includeKeys : undefined;
  await saveJob(job, { source: "figma-include" });
  return { ok: true, includeKeys, job };
}

export async function getJobFigmaStatus(jobId: string): Promise<{
  hasFigmaToken: boolean;
  projectId: string | null;
  pendingFigmaUrls: string[];
  includeKeys: string[];
}> {
  const job = await requireJobRecord(jobId);
  let hasFigmaToken = false;
  if (job.workspaceProjectId) {
    const secrets = await getProjectSecrets(job.workspaceProjectId);
    hasFigmaToken = Boolean(secrets?.figmaToken);
  }
  return {
    hasFigmaToken,
    projectId: job.workspaceProjectId ?? null,
    pendingFigmaUrls: job.pendingFigmaUrls ?? [],
    includeKeys: job.figmaIncludeKeys ?? [],
  };
}

/** After PAT saved in Settings — re-enqueue if paused for Figma. */
export async function continueJobAfterFigmaAuth(jobId: string): Promise<{
  ok: boolean;
  enqueued: boolean;
  reason?: string;
  job: JobRecord;
}> {
  const job = await requireJobRecord(jobId);
  if (job.status === "awaiting_figma_auth") {
    job.status = "draft";
    job.error = undefined;
    await saveJob(job);
  }
  if (job.workspaceProjectId) {
    const { requireProjectLocalClone } = await import(
      "../../workspace/resolve.js"
    );
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  const result = await jobQueue.enqueueExisting(jobId, {
    source: "figma_auth_continue",
  });
  const fresh = await requireJobRecord(jobId);
  return {
    ok: result.enqueued,
    enqueued: result.enqueued,
    reason: result.reason,
    job: fresh,
  };
}

/**
 * Before agent Run: opt-in Figma links → gate on missing PAT or fetch prompt block.
 */
export async function prepareFigmaForJob(
  job: JobRecord,
  chatBodies?: string[],
): Promise<{ gate: true } | { gate: false; promptBlock: string }> {
  const includeKeys = new Set(
    (job.figmaIncludeKeys ?? []).map((s) => s.trim()).filter(Boolean),
  );
  if (!includeKeys.size) {
    return { gate: false, promptBlock: "" };
  }

  const allRefs = await collectJobFigmaRefs(job, chatBodies);
  const refs = allRefs.filter((r) => includeKeys.has(figmaIncludeKey(r)));
  if (!refs.length) {
    return { gate: false, promptBlock: "" };
  }

  const projectId = job.workspaceProjectId?.trim();
  if (!projectId) {
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body:
        "⚠️ Đã chọn đọc Figma nhưng job **chưa gắn workspace project** — không lấy được PAT.\n" +
        "Chọn project rồi Run lại.",
    });
    return { gate: false, promptBlock: "" };
  }

  const secrets = await getProjectSecrets(projectId);
  const pat = secrets?.figmaToken?.trim();
  if (!pat) {
    const project = await getProject(projectId);
    job.status = "awaiting_figma_auth";
    job.pendingFigmaUrls = refs.map((r) => r.url);
    job.error = "Add Figma PAT in Settings → Integrations";
    await saveJob(job, { source: "awaiting-figma-auth" });
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body:
        `🔗 Đã chọn **${refs.length}** link Figma nhưng project **${project?.displayName || projectId}** chưa có Figma PAT.\n` +
        `Vào **Settings → Integrations**, dán Personal Access Token (scope \`file_content:read\`), rồi **Continue Run**.`,
    });
    return { gate: true };
  }

  const blocks = [];
  for (const ref of refs) {
    blocks.push(await fetchFigmaForPrompt(pat, ref));
  }

  job.pendingFigmaUrls = undefined;
  if (job.status === "awaiting_figma_auth") {
    job.status = "draft";
    job.error = undefined;
  }
  await saveJob(job, { source: "figma-fetch" });

  const okBlocks = blocks.filter((b) => !b.error);
  const failBlocks = blocks.filter((b) => b.error);
  const lines: string[] = [];
  if (okBlocks.length) {
    lines.push(
      `✅ **Đã đọc Figma** (${okBlocks.length}/${blocks.length}) vào agent context:`,
    );
    for (const b of okBlocks) {
      const trunc = b.truncated ? " · truncated" : "";
      const label = b.rootName || b.fileName || b.fileKey;
      lines.push(`- ✓ **${label}** (${b.kind})${trunc}`);
    }
  }
  if (failBlocks.length) {
    lines.push(
      okBlocks.length
        ? `\n❌ **Không đọc được** ${failBlocks.length} Figma:`
        : `❌ **Không đọc được** Figma (${failBlocks.length}):`,
    );
    for (const b of failBlocks) {
      lines.push(`- ✗ \`${figmaIncludeKey(b)}\` — ${b.error}`);
    }
  }
  await addChatMessage({
    jobId: job.id,
    issueIid: job.issue.issueIid,
    role: "agent",
    kind: "qa",
    body: lines.join("\n"),
  });

  logger.info("Figma prep done", {
    jobId: job.id,
    ok: okBlocks.length,
    fail: failBlocks.length,
  });

  return {
    gate: false,
    promptBlock: formatFigmaPromptBlock(blocks),
  };
}
