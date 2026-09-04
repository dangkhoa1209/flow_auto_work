/**
 * Handoff + merge: apply GitLab issue actions, merge work branch via MR API.
 * On MR conflicts, the Cursor agent resolves them locally and the MR is retried.
 */
import { addChatMessage } from "../../models/chat.js";
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import type { IssueJob, JobRecord } from "../../types.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobDoc } from "./lifecycle.js";

export type CompletionActionsInput = {
  assignees?: string[];
  labels?: string[];
  removeLabels?: string[];
  labelMode?: "add" | "set";
  comment?: string;
};

export async function applyCompletionActions(
  jobId: string,
  input: CompletionActionsInput,
) {
  const job = await requireJobDoc(jobId);
  if (job.status !== "awaiting_handoff" && job.status !== "succeeded") {
    throw new AppError(
      "Handoff only for awaiting_handoff (or succeeded retry)",
      409,
    );
  }
  const assignees = (input.assignees ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const labels = (input.labels ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const removeLabels = (input.removeLabels ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const comment = input.comment?.trim();
  if (
    !assignees.length &&
    !labels.length &&
    !removeLabels.length &&
    !comment &&
    input.labelMode !== "set"
  ) {
    throw new AppError("Need assignees, labels, removeLabels, or comment", 400);
  }

  const { applyIssueActions } = await import("../../plugins/scm/index.js");
  const { resolveProcessingLabel } = await import(
    "../../plugins/gitlab/processing-label.js"
  );
  const proc = resolveProcessingLabel(job.completion?.processingLabel);
  const removeWithProcessing = [
    ...new Set([...removeLabels, proc].map((s) => s.trim()).filter(Boolean)),
  ];
  await applyIssueActions({
    projectId: job.issue.projectId,
    issueIid: job.issue.issueIid,
    assignees,
    labels,
    removeLabels: removeWithProcessing,
    labelMode: input.labelMode === "set" ? "set" : "add",
    comment,
  });

  job.status = "succeeded";
  job.handedOffAt = new Date().toISOString();
  job.error = undefined;
  await saveJob(job);
  return { ok: true, job };
}

const MR_CONFLICT_RE = /cannot_be_merged|conflict|Branch cannot be merged/i;

export type PullBaseResult = {
  summary: string;
  aiResolved: boolean;
  alreadyUpToDate: boolean;
  commitSha: string | null;
  wipWarning?: string;
  /** AI failed — merge left open for Chat Send to resolve */
  needsChatResolve?: boolean;
  conflictedFiles?: string[];
  /** Kept until chat finalize or abort (only when needsChatResolve) */
  wipStashMarker?: string | null;
};

/**
 * Abort an open merge left for chat resolve and restore any WIP stash.
 */
export async function abortPendingConflictOnRepo(
  repoPath: string,
  pending?: JobRecord["pendingConflictResolve"],
): Promise<{ wipWarning?: string }> {
  const {
    abortMerge,
    isMergeInProgress,
    restoreWipAfterMerge,
  } = await import("../../plugins/git/merge.js");
  if (await isMergeInProgress(repoPath)) {
    await abortMerge(repoPath).catch(() => undefined);
  }
  let wipWarning: string | undefined;
  if (pending?.wipStashMarker) {
    const wip = await restoreWipAfterMerge(repoPath, pending.wipStashMarker);
    if (wip.warning) wipWarning = wip.warning;
  }
  return { wipWarning };
}

async function tryAiClearConflicts(opts: {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  conflictedFiles: string[];
  issue?: IssueJob;
}): Promise<{ cleared: true; summary: string } | { cleared: false; files: string[]; summary: string }> {
  const { resolveMergeConflictsWithAi } = await import(
    "../../plugins/agent/merge-resolve.js"
  );
  const { listConflictedFiles } = await import("../../plugins/git/merge.js");
  let files = opts.conflictedFiles;
  let text = "";
  try {
    for (let round = 0; round < 2 && files.length; round++) {
      const resolved = await resolveMergeConflictsWithAi({
        sourceBranch: opts.sourceBranch,
        targetBranch: opts.targetBranch,
        conflictedFiles: files,
        issue: opts.issue,
      });
      text = text ? `${text}\n---\n${resolved.text}` : resolved.text;
      files = resolved.remaining;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const remaining = await listConflictedFiles(opts.repoPath).catch(() => files);
    return {
      cleared: false,
      files: remaining.length ? remaining : files,
      summary: text ? `${text}\n---\nAI error: ${msg}` : `AI error: ${msg}`,
    };
  }
  if (files.length) {
    return { cleared: false, files, summary: text || "(unresolved)" };
  }
  return { cleared: true, summary: text || "(resolved)" };
}

/**
 * Pull latest base (target) INTO the job work branch:
 * stash WIP → fetch origin → merge target into work branch → Cursor agent
 * clears conflict markers if any → commit + push work branch → restore WIP.
 * Base branch is never pushed directly (it is often protected).
 * Used by the Sync-base button and as MR-conflict auto-fix during merge.
 *
 * If AI cannot clear conflicts, the merge is **left open** (not aborted) so
 * the user can Chat Send to resolve — avoids a stuck dirty MERGE_HEAD with no recovery.
 */
async function pullBaseIntoWorkBranch(opts: {
  repoPath: string;
  source: string;
  target: string;
  issue?: IssueJob;
}): Promise<PullBaseResult> {
  const {
    attemptMergeIntoBase,
    abortMerge,
    finalizeMergeCommit,
    tryCheckoutBranch,
    restoreWipAfterMerge,
    listConflictedFiles,
  } = await import("../../plugins/git/merge.js");
  const { pushBranch } = await import("../../plugins/git/prep.js");

  // Reversed args on purpose: checkout `source` (work branch), merge `target` into it.
  // attemptMergeIntoBase also refreshes both branches from origin first.
  const attempt = await attemptMergeIntoBase({
    repoPath: opts.repoPath,
    sourceBranch: opts.target,
    targetBranch: opts.source,
  });
  const previousBranch = attempt.previousBranch;
  const wipStashMarker = attempt.wipStashMarker;
  let wipWarning: string | undefined;
  /** Leave MERGE_HEAD for chat — skip abort / branch restore / stash pop in finally */
  let leaveOpenForChat = false;

  try {
    let aiResolved = false;
    let summary = "(merged clean — no AI needed)";
    if (attempt.status === "conflict") {
      const ai = await tryAiClearConflicts({
        repoPath: opts.repoPath,
        sourceBranch: opts.target,
        targetBranch: opts.source,
        conflictedFiles: attempt.conflictedFiles,
        issue: opts.issue,
      });
      if (!ai.cleared) {
        leaveOpenForChat = true;
        const files =
          ai.files.length > 0
            ? ai.files
            : await listConflictedFiles(opts.repoPath);
        return {
          summary: ai.summary,
          aiResolved: false,
          alreadyUpToDate: false,
          commitSha: null,
          needsChatResolve: true,
          conflictedFiles: files,
          wipStashMarker,
        };
      }
      aiResolved = true;
      summary = ai.summary;
    }

    const alreadyUpToDate =
      attempt.status === "merged" && Boolean(attempt.alreadyUpToDate);
    const commitSha = await finalizeMergeCommit(
      opts.repoPath,
      `Merge branch '${opts.target}' into ${opts.source}` +
        (aiResolved ? " (AI conflict resolve)" : ""),
    );
    if (!alreadyUpToDate) {
      await pushBranch(opts.repoPath, opts.source);
    }
    logger.info("Pulled base into work branch", {
      source: opts.source,
      target: opts.target,
      aiResolved,
      alreadyUpToDate,
      sha: commitSha,
    });
    return { summary, aiResolved, alreadyUpToDate, commitSha, wipWarning };
  } catch (err) {
    await abortMerge(opts.repoPath).catch(() => undefined);
    throw err;
  } finally {
    if (!leaveOpenForChat) {
      if (previousBranch) await tryCheckoutBranch(opts.repoPath, previousBranch);
      const wip = await restoreWipAfterMerge(opts.repoPath, wipStashMarker);
      if (wip.warning) wipWarning = wip.warning;
    }
  }
}

async function markJobNeedsChatConflictResolve(
  job: JobRecord,
  pending: NonNullable<JobRecord["pendingConflictResolve"]>,
  summary: string,
) {
  job.pendingConflictResolve = pending;
  job.mergeError = `Conflict — use Chat Send to resolve: ${pending.files.join(", ")}`;
  await saveJob(job);
  const fileList = pending.files.map((f) => `- ${f}`).join("\n");
  await addChatMessage({
    jobId: job.id,
    issueIid: job.issue.issueIid,
    role: "system",
    kind: "note",
    body:
      `⚠️ Merge conflict — automatic AI resolve did not finish.\n\n` +
      `Conflicted files:\n${fileList || "- (unknown)"}\n\n` +
      `**Chat is still available.** Send a message (e.g. "resolve the merge conflicts") ` +
      `and the agent will clear conflict markers. When markers are gone, Flow finalizes the merge commit and push.\n\n` +
      `Or press **Sync base** again to abort this merge and retry.\n\n` +
      (summary.trim() ? `AI notes:\n${summary.trim().slice(0, 2000)}` : ""),
  });
}

/**
 * After Chat clears conflict markers: finalize merge commit, push, restore WIP.
 */
export async function tryFinalizePendingConflict(
  job: JobRecord,
  repoPath: string,
): Promise<
  | { status: "none" }
  | { status: "still_conflicted"; files: string[] }
  | { status: "finalized"; commitSha: string | null; wipWarning?: string }
> {
  const pending = job.pendingConflictResolve;
  const {
    listConflictedFiles,
    isMergeInProgress,
    finalizeMergeCommit,
    restoreWipAfterMerge,
  } = await import("../../plugins/git/merge.js");
  const { pushBranch } = await import("../../plugins/git/prep.js");

  const mergeOpen = await isMergeInProgress(repoPath);
  if (!pending && !mergeOpen) return { status: "none" };

  const files = await listConflictedFiles(repoPath);
  if (files.length) {
    if (pending) {
      job.pendingConflictResolve = { ...pending, files };
      await saveJob(job);
    }
    return { status: "still_conflicted", files };
  }

  if (!mergeOpen) {
    if (pending) {
      job.pendingConflictResolve = undefined;
      job.mergeError = undefined;
      await saveJob(job);
    }
    return { status: "none" };
  }

  const source = pending?.source || "";
  const target =
    pending?.target?.trim() ||
    (await import("../../plugins/git/merge.js").then((m) =>
      m.getCurrentBranch(repoPath),
    )) ||
    "";
  const kind = pending?.kind || "sync-base";
  const commitSha = await finalizeMergeCommit(
    repoPath,
    `Merge branch '${source || "incoming"}' into ${target || "HEAD"} (chat conflict resolve)`,
  );
  // Checked-out branch that received the merge is pending.target (or current HEAD)
  const branchToPush = target.trim();
  if (branchToPush) {
    await pushBranch(repoPath, branchToPush);
  }

  let wipWarning: string | undefined;
  if (pending?.wipStashMarker) {
    const wip = await restoreWipAfterMerge(repoPath, pending.wipStashMarker);
    if (wip.warning) wipWarning = wip.warning;
  }

  job.pendingConflictResolve = undefined;
  job.mergeError = undefined;
  if (commitSha) {
    job.commitSha = commitSha;
    job.commitShas = [...(job.commitShas ?? []), commitSha].slice(-20);
  }
  if (kind === "merge") {
    job.mergedAt = new Date().toISOString();
    job.mergeTarget = target;
    job.mergeSource = source;
    job.mergeSha = commitSha ?? undefined;
    job.mergeAiResolved = true;
    job.mergePushedAt = new Date().toISOString();
  }
  await saveJob(job);

  logger.info("Finalized pending conflict via chat", {
    jobId: job.id,
    kind,
    sha: commitSha,
    branchToPush,
  });

  return { status: "finalized", commitSha, wipWarning };
}

/** Prompt block when a merge is waiting on chat conflict resolve. */
export function conflictResolvePromptBlock(
  pending: NonNullable<JobRecord["pendingConflictResolve"]>,
): string {
  const files = pending.files.map((f) => `- ${f}`).join("\n") || "- (see git status)";
  return `# MERGE CONFLICT RESOLVE (HIGHEST PRIORITY THIS TURN)
There is an **open git merge** on branch \`${pending.target}\` (merging \`${pending.source}\` in).
Conflicted files:
${files}

## Your job
1. Open each conflicted file and resolve EVERY conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
2. Keep feature work from the appropriate side; do not leave markers.
3. \`git add\` the resolved files when done.
4. Do NOT \`git commit\`, \`git merge --abort\`, push, or force-push — Flow will finalize the merge commit after you finish.
5. Prefer small, correct resolutions.

Then briefly summarize what you resolved.
`;
}

/**
 * Sync-base button: pull latest base branch into the job work branch.
 * Stash WIP → pull → AI-fix conflicts if any → push work branch → unstash.
 * If AI cannot clear conflicts, leave merge open and let the user Chat to finish.
 */
export async function syncJobBranchWithBase(
  jobId: string,
  input: { targetBranch?: string },
) {
  const job = await requireJobDoc(jobId);
  if (job.status === "running" || job.status === "queued") {
    throw new AppError("Job is running — stop it or wait before syncing base", 409);
  }
  const source = (job.branch || job.workBranch || "").trim();
  if (!source) {
    throw new AppError("Job has no work branch to sync", 400);
  }

  const { getRuntimeContext } = await import("../../workspace/runtime.js");

  const rt = getRuntimeContext();
  const repoPath = rt?.repoPath?.trim();
  if (!repoPath) {
    throw new AppError("No local repo path — join a project first", 400);
  }

  // Clear a previous half-open conflict so Sync base can retry cleanly
  if (job.pendingConflictResolve) {
    const cleared = await abortPendingConflictOnRepo(
      repoPath,
      job.pendingConflictResolve,
    );
    job.pendingConflictResolve = undefined;
    job.mergeError = undefined;
    await saveJob(job);
    if (cleared.wipWarning) {
      logger.warn("WIP warning while aborting prior conflict", {
        jobId: job.id,
        warning: cleared.wipWarning,
      });
    }
  } else {
    const { isMergeInProgress, abortMerge } = await import(
      "../../plugins/git/merge.js"
    );
    if (await isMergeInProgress(repoPath)) {
      await abortMerge(repoPath).catch(() => undefined);
    }
  }

  // Settings project branch wins — job.baseBranch is a stale snapshot and the
  // GitLab default branch is a guess. No setting → user must pick explicitly.
  const target = input.targetBranch?.trim() || rt?.baseBranch?.trim() || "";
  if (!target) {
    throw new AppError(
      "BASE_BRANCH_NOT_SET: Project main branch is not set — pick a source branch to pull",
      400,
    );
  }
  if (target === source) {
    throw new AppError("Work branch IS the base branch — nothing to sync", 400);
  }

  const result = await pullBaseIntoWorkBranch({
    repoPath,
    source,
    target,
    issue: job.issue,
  });

  if (result.needsChatResolve) {
    // pending: source=base (incoming), target=work (checked out)
    await markJobNeedsChatConflictResolve(
      job,
      {
        kind: "sync-base",
        source: target,
        target: source,
        files: result.conflictedFiles ?? [],
        wipStashMarker: result.wipStashMarker,
        startedAt: new Date().toISOString(),
      },
      result.summary,
    );
    logger.warn("Sync base needs chat conflict resolve", {
      jobId: job.id,
      source,
      target,
      files: result.conflictedFiles,
    });
    return {
      ok: true,
      job,
      sync: {
        source,
        target,
        ...result,
      },
    };
  }

  if (result.commitSha && !result.alreadyUpToDate) {
    job.commitSha = result.commitSha;
    job.commitShas = [...(job.commitShas ?? []), result.commitSha].slice(-20);
    job.pendingConflictResolve = undefined;
    job.mergeError = undefined;
    await saveJob(job);
  }

  logger.info("Job branch synced with base", {
    jobId: job.id,
    source,
    target,
    aiResolved: result.aiResolved,
    alreadyUpToDate: result.alreadyUpToDate,
  });

  return {
    ok: true,
    job,
    sync: {
      source,
      target,
      ...result,
    },
  };
}

/**
 * Merge job work branch into project/base.
 * - If an open MR already exists → accept it (never creates a new MR).
 * - Otherwise → local git merge work → base + push (no MR).
 */
export async function mergeJobBranch(
  jobId: string,
  input: { targetBranch?: string },
) {
  const job = await requireJobDoc(jobId);
  if (job.status !== "awaiting_handoff" && job.status !== "succeeded") {
    throw new AppError("Merge only for awaiting_handoff or succeeded jobs", 409);
  }
  const source = (job.branch || job.workBranch || "").trim();
  if (!source) {
    throw new AppError("Job has no work branch to merge", 400);
  }
  const { resolveGitlabProjectPath } = await import("../../workspace/creds.js");
  const { getRuntimeContext } = await import("../../workspace/runtime.js");
  const {
    findOpenMergeRequest,
    acceptMergeRequest,
    getProjectDefaultBranch,
    waitUntilMrReady,
  } = await import("../../plugins/scm/index.js");
  const { syncLocalToRemoteCommit } = await import(
    "../../plugins/git/changes-for-api.js"
  );

  const rt = getRuntimeContext();
  const repoPath = rt?.repoPath?.trim() || undefined;
  const projectIdOrPath: number | string =
    rt?.gitlabProjectId ?? job.issue?.projectId ?? resolveGitlabProjectPath();

  let target =
    input.targetBranch?.trim() ||
    job.baseBranch?.trim() ||
    rt?.baseBranch?.trim() ||
    "";
  if (!target) {
    try {
      target = await getProjectDefaultBranch(projectIdOrPath);
    } catch {
      /* fall through */
    }
  }
  if (!target) {
    throw new AppError(
      "Could not determine target branch (base/default)",
      400,
    );
  }

  job.mergeError = undefined;
  job.mergePushError = undefined;
  // Fresh merge attempt — drop a prior chat-resolve leftover if any
  if (job.pendingConflictResolve && repoPath) {
    await abortPendingConflictOnRepo(repoPath, job.pendingConflictResolve);
    job.pendingConflictResolve = undefined;
    await saveJob(job);
  } else {
    await saveJob(job);
  }

  try {
    const existingMr = await findOpenMergeRequest({
      projectId: projectIdOrPath,
      sourceBranch: source,
      targetBranch: target,
    });

    // Prefer accepting an already-open MR — never create one here (use Create MR).
    if (existingMr) {
      let aiResolved = false;
      let aiSummary: string | undefined;
      const { appendJobProgress } = await import(
        "../../plugins/agent/progress.js"
      );

      /** Sync base → work + AI clear conflicts, then GitLab can accept the MR. */
      const aiFixMrConflicts = async (reason: string) => {
        if (!repoPath) {
          throw new AppError(
            "MR has conflicts but no local repo for AI auto-fix — attach a project clone or Sync base manually",
            409,
          );
        }
        logger.warn("MR conflicts — AI auto-resolve (same as Sync base)", {
          jobId: job.id,
          mrIid: existingMr.iid,
          source,
          target,
          reason,
        });
        appendJobProgress(
          job.id,
          "status",
          "MR conflict — AI resolving (same as Sync base)…",
        );
        const fix = await pullBaseIntoWorkBranch({
          repoPath,
          source,
          target,
          issue: job.issue,
        });
        if (fix.needsChatResolve) {
          await markJobNeedsChatConflictResolve(
            job,
            {
              kind: "sync-base",
              source: target,
              target: source,
              files: fix.conflictedFiles ?? [],
              wipStashMarker: fix.wipStashMarker,
              startedAt: new Date().toISOString(),
            },
            fix.summary,
          );
          throw new AppError(
            `MR conflict — AI could not clear; use Chat Send to resolve: ${(fix.conflictedFiles ?? []).join(", ")}`,
            409,
          );
        }
        aiResolved = aiResolved || fix.aiResolved || !fix.alreadyUpToDate;
        aiSummary = fix.summary;
        appendJobProgress(
          job.id,
          "status",
          fix.aiResolved
            ? "AI resolved conflict — retrying MR accept"
            : "Synced base into work — retrying MR accept",
        );
      };

      // Proactive: GitLab already marks conflicts → fix before first accept
      if (repoPath) {
        try {
          const ready = await waitUntilMrReady({
            projectId: projectIdOrPath,
            mergeRequestIid: existingMr.iid,
            timeoutMs: 45_000,
          });
          const st = (
            ready.detailed_merge_status ||
            ready.merge_status ||
            ""
          ).toLowerCase();
          if (
            ready.state !== "merged" &&
            (ready.has_conflicts || st === "cannot_be_merged")
          ) {
            await aiFixMrConflicts("precheck");
          }
        } catch (err) {
          // Soft — still attempt accept; conflict path below will retry with AI
          logger.warn("MR precheck failed — will accept and retry on conflict", {
            jobId: job.id,
            err: String(err),
          });
        }
      }

      let merged;
      try {
        merged = await acceptMergeRequest({
          projectId: projectIdOrPath,
          mergeRequestIid: existingMr.iid,
          mergeCommitMessage: `Merge branch '${source}' into ${target}`,
          shouldRemoveSourceBranch: false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!MR_CONFLICT_RE.test(msg)) throw err;
        await aiFixMrConflicts("accept-failed");
        merged = await acceptMergeRequest({
          projectId: projectIdOrPath,
          mergeRequestIid: existingMr.iid,
          mergeCommitMessage: `Merge branch '${source}' into ${target}`,
          shouldRemoveSourceBranch: false,
        });
      }

      const mergeSha = merged.mergeCommitSha;
      let localSynced = false;
      let syncError: string | undefined;
      if (mergeSha && repoPath) {
        try {
          await syncLocalToRemoteCommit(repoPath, target, mergeSha);
          localSynced = true;
        } catch (err) {
          syncError = err instanceof Error ? err.message : String(err);
          logger.warn("GitLab merge ok but local sync failed", {
            jobId: job.id,
            target,
            sha: mergeSha,
            err: syncError,
          });
        }
      }

      job.mergedAt = new Date().toISOString();
      job.mergeTarget = target;
      job.mergeSource = source;
      job.mergeSha = mergeSha ?? undefined;
      job.mergeAiResolved = aiResolved;
      job.mergeError = undefined;
      job.mergePushedAt = new Date().toISOString();
      job.mergePushError = syncError;
      if (mergeSha) {
        job.commitSha = mergeSha;
        job.commitShas = [...(job.commitShas ?? []), mergeSha].slice(-20);
      }
      await saveJob(job);

      logger.info("Job branch merged via existing MR", {
        jobId: job.id,
        source,
        target,
        sha: mergeSha,
        mrIid: existingMr.iid,
        localSynced,
        aiResolved,
      });

      return {
        ok: true,
        job,
        merge: {
          source,
          target,
          commitSha: mergeSha,
          alreadyUpToDate: merged.alreadyMerged ?? false,
          via: "gitlab_mr_accept",
          mergeRequestIid: existingMr.iid,
          mergeRequestUrl: merged.webUrl || existingMr.webUrl,
          createdMr: false,
          localSynced,
          syncError: syncError ?? null,
          aiResolved,
          aiSummary: aiSummary ?? null,
        },
      };
    }

    // No open MR — local merge work → base + push (does not create MR)
    if (!repoPath) {
      throw new AppError(
        "No open MR and no local repo for a direct merge. Create MR first, or attach a project clone.",
        409,
      );
    }

    const {
      attemptMergeIntoBase,
      abortMerge,
      finalizeMergeCommit,
      tryCheckoutBranch,
      restoreWipAfterMerge,
      listConflictedFiles,
    } = await import("../../plugins/git/merge.js");
    const { pushBranch } = await import("../../plugins/git/prep.js");

    const attempt = await attemptMergeIntoBase({
      repoPath,
      sourceBranch: source,
      targetBranch: target,
    });
    const previousBranch = attempt.previousBranch;
    const wipStashMarker = attempt.wipStashMarker;
    let aiResolved = false;
    let aiSummary: string | undefined;
    let wipWarning: string | undefined;
    let leaveOpenForChat = false;

    try {
      if (attempt.status === "conflict") {
        const { appendJobProgress } = await import(
          "../../plugins/agent/progress.js"
        );
        appendJobProgress(
          job.id,
          "status",
          "Merge conflict — AI resolving (same as Sync base)…",
        );
        const ai = await tryAiClearConflicts({
          repoPath,
          sourceBranch: source,
          targetBranch: target,
          conflictedFiles: attempt.conflictedFiles,
          issue: job.issue,
        });
        if (!ai.cleared) {
          leaveOpenForChat = true;
          const files =
            ai.files.length > 0
              ? ai.files
              : await listConflictedFiles(repoPath);
          await markJobNeedsChatConflictResolve(
            job,
            {
              kind: "merge",
              source,
              target,
              files,
              wipStashMarker,
              startedAt: new Date().toISOString(),
            },
            ai.summary,
          );
          return {
            ok: true,
            job,
            merge: {
              source,
              target,
              commitSha: null,
              alreadyUpToDate: false,
              via: "local_git",
              mergeRequestIid: null,
              mergeRequestUrl: null,
              createdMr: false,
              localSynced: false,
              syncError: null,
              aiResolved: false,
              aiSummary: ai.summary,
              needsChatResolve: true,
              conflictedFiles: files,
              wipWarning: null,
            },
          };
        }
        aiResolved = true;
        aiSummary = ai.summary;
        appendJobProgress(
          job.id,
          "status",
          "AI resolved conflict — finalizing merge",
        );
      }

      const alreadyUpToDate =
        attempt.status === "merged" && Boolean(attempt.alreadyUpToDate);
      const commitSha = await finalizeMergeCommit(
        repoPath,
        `Merge branch '${source}' into ${target}` +
          (aiResolved ? " (AI conflict resolve)" : ""),
      );
      if (!alreadyUpToDate) {
        await pushBranch(repoPath, target);
      }

      job.mergedAt = new Date().toISOString();
      job.mergeTarget = target;
      job.mergeSource = source;
      job.mergeSha = commitSha ?? undefined;
      job.mergeAiResolved = aiResolved;
      job.mergeError = undefined;
      job.pendingConflictResolve = undefined;
      job.mergePushedAt = new Date().toISOString();
      job.mergePushError = undefined;
      if (commitSha) {
        job.commitSha = commitSha;
        job.commitShas = [...(job.commitShas ?? []), commitSha].slice(-20);
      }
      await saveJob(job);

      logger.info("Job branch merged locally (no MR)", {
        jobId: job.id,
        source,
        target,
        sha: commitSha,
        alreadyUpToDate,
        aiResolved,
      });

      return {
        ok: true,
        job,
        merge: {
          source,
          target,
          commitSha,
          alreadyUpToDate,
          via: "local_git",
          mergeRequestIid: null,
          mergeRequestUrl: null,
          createdMr: false,
          localSynced: true,
          syncError: null,
          aiResolved,
          aiSummary: aiSummary ?? null,
          wipWarning: wipWarning ?? null,
        },
      };
    } catch (err) {
      if (!leaveOpenForChat) {
        await abortMerge(repoPath).catch(() => undefined);
      }
      throw err;
    } finally {
      if (!leaveOpenForChat) {
        if (previousBranch) await tryCheckoutBranch(repoPath, previousBranch);
        const wip = await restoreWipAfterMerge(repoPath, wipStashMarker);
        if (wip.warning) wipWarning = wip.warning;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job.mergeError = msg;
    await saveJob(job);
    logger.warn("Merge failed", { jobId: job.id, err: msg });
    if (err instanceof AppError) throw err;
    throw new AppError(msg, MR_CONFLICT_RE.test(msg) ? 409 : 500);
  }
}
