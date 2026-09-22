/**
 * Handoff + merge: apply GitLab issue actions, merge work branch via MR API.
 * On MR conflicts, the Cursor agent resolves them locally and the MR is retried.
 */
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import { redactGitCredentials, safeErrorMessage } from "../../plugins/git/redact.js";
import type { IssueJob, JobRecord } from "../../types.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobDoc } from "./lifecycle.js";

const MERGE_OP_HISTORY_MAX = 30;

type MergeOpHistoryEntry = NonNullable<JobRecord["mergeOpHistory"]>[number];

/**
 * Before finalizing Sync/Merge from the queue: if Force Stop (or reclaim) already
 * cleared pendingMergeOp, abort so we do not overwrite kill status / History.
 */
async function assertQueuedMergeOpStillActive(
  jobId: string,
  kind: "sync-base" | "merge",
  fromQueue?: boolean,
): Promise<void> {
  if (!fromQueue) return;
  const fresh = await requireJobDoc(jobId);
  if (!fresh.pendingMergeOp || fresh.pendingMergeOp.kind !== kind) {
    throw new AppError("Force-stopped from UI", 409);
  }
}

/** Append Sync base / Merge outcome for /work Issue tab (redact secrets). */
export function pushMergeOpHistory(
  job: JobRecord,
  entry: Omit<MergeOpHistoryEntry, "at" | "message" | "detail"> & {
    message: string;
    at?: string;
    detail?: string;
  },
): void {
  const detailRaw = String(entry.detail || "").trim();
  const row: MergeOpHistoryEntry = {
    kind: entry.kind,
    status: entry.status,
    at: entry.at || new Date().toISOString(),
    message: redactGitCredentials(String(entry.message || "").trim()).slice(
      0,
      2000,
    ),
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.target ? { target: entry.target } : {}),
    ...(entry.aiResolved ? { aiResolved: true } : {}),
    ...(detailRaw
      ? {
          detail: redactGitCredentials(detailRaw).slice(0, 8000),
        }
      : {}),
  };
  // Finalize in place: replace the queued "processing" row so History does not
  // keep a stale processing line after the op completes.
  if (entry.status !== "processing") {
    const hist = job.mergeOpHistory ?? [];
    // Prefer same kind; otherwise any processing (MR-conflict may log as sync-base
    // while the queued op was merge).
    let idx = hist.findIndex(
      (h) => h.status === "processing" && h.kind === entry.kind,
    );
    if (idx < 0) {
      idx = hist.findIndex((h) => h.status === "processing");
    }
    if (idx >= 0) {
      job.mergeOpHistory = [
        ...hist.slice(0, idx),
        row,
        ...hist.slice(idx + 1),
      ].slice(0, MERGE_OP_HISTORY_MAX);
      return;
    }
  }
  job.mergeOpHistory = [row, ...(job.mergeOpHistory ?? [])].slice(
    0,
    MERGE_OP_HISTORY_MAX,
  );
}

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

/**
 * After prepareRepoForIssue may have aborted a wrong-branch MERGE_HEAD, drop a
 * stale chat-resolve handoff so Chat/Run do not keep conflict UI/state.
 * Returns true when pending was cleared.
 */
export async function clearStalePendingConflictIfNeeded(
  job: JobRecord,
  repoPath: string,
): Promise<boolean> {
  if (!job.pendingConflictResolve) return false;
  const { isMergeInProgress } = await import("../../plugins/git/merge.js");
  const mergeOpen = await isMergeInProgress(repoPath);
  const pendingTarget = (job.pendingConflictResolve.target || "").trim();
  const expected = (job.branch || job.workBranch || "").trim();
  if (
    !mergeOpen ||
    (pendingTarget && expected && pendingTarget !== expected)
  ) {
    await abortPendingConflictOnRepo(repoPath, job.pendingConflictResolve);
    job.pendingConflictResolve = undefined;
    job.mergeError = undefined;
    return true;
  }
  return false;
}

async function tryAiClearConflicts(opts: {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  conflictedFiles: string[];
  issue?: IssueJob;
  jobId?: string;
  userId?: string;
}): Promise<{ cleared: true; summary: string } | { cleared: false; files: string[]; summary: string }> {
  const { resolveMergeConflictsWithAi } = await import(
    "../../plugins/agent/merge-resolve.js"
  );
  const { listConflictedFiles, stageClearedConflictFiles } = await import(
    "../../plugins/git/merge.js"
  );
  let files = opts.conflictedFiles;
  let text = "";
  const maxRounds = 4;
  try {
    for (let round = 0; round < maxRounds && files.length; round++) {
      const resolved = await resolveMergeConflictsWithAi({
        sourceBranch: opts.sourceBranch,
        targetBranch: opts.targetBranch,
        conflictedFiles: files,
        issue: opts.issue,
        jobId: opts.jobId,
        userId: opts.userId,
      });
      text = text
        ? `${text}\n\n---\n\n**Round ${round + 1}**\n\n${resolved.text}`
        : resolved.text;
      // Orchestrator stages files whose markers are gone (AI often forgets git add).
      const stillMarked = await stageClearedConflictFiles(opts.repoPath, files);
      const unmerged = await listConflictedFiles(opts.repoPath);
      files = [...new Set([...unmerged, ...stillMarked])];
      if (files.length) {
        logger.info("AI conflict resolve round incomplete", {
          round: round + 1,
          remaining: files,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const remaining = await listConflictedFiles(opts.repoPath).catch(() => files);
    return {
      cleared: false,
      files: remaining.length ? remaining : files,
      summary: text
        ? `${text}\n\n---\n\n**AI error:** ${msg}`
        : `**AI error:** ${msg}`,
    };
  }
  if (files.length) {
    return { cleared: false, files, summary: text || "(unresolved)" };
  }
  return { cleared: true, summary: text || "(resolved)" };
}

/**
 * AI could not clear conflicts — abort merge then throw so History records
 * error. Caller finally restores branch + WIP. User retries Sync base / Merge
 * (button or Chat request). Does **not** leave MERGE_HEAD for Chat resolve.
 */
async function failConflictAfterAi(opts: {
  repoPath: string;
  files: string[];
  summary: string;
  opLabel: string;
}): Promise<never> {
  const { abortMerge } = await import("../../plugins/git/merge.js");
  await abortMerge(opts.repoPath).catch(() => undefined);
  const fileHint = opts.files.slice(0, 12).join(", ");
  const detail = opts.summary.trim().slice(0, 800);
  throw new AppError(
    `${opts.opLabel} conflict unresolved after AI` +
      (fileHint ? `: ${fileHint}${opts.files.length > 12 ? "…" : ""}` : "") +
      `. Retry Sync base / Merge (or Chat to request again).` +
      (detail ? ` — ${detail}` : ""),
    409,
  );
}

/**
 * Pull latest base (target) INTO the job work branch:
 * stash WIP → fetch origin → merge target into work branch → Cursor agent
 * clears conflict markers if any → commit + push work branch → restore WIP.
 * Base branch is never pushed directly (it is often protected).
 * Used by the Sync-base button and as MR-conflict auto-fix during merge.
 *
 * If AI cannot clear conflicts after retries, the merge is **aborted** and an
 * error is thrown — retry Sync base / Merge (or Chat to request again).
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
        const files =
          ai.files.length > 0
            ? ai.files
            : await listConflictedFiles(opts.repoPath);
        await failConflictAfterAi({
          repoPath: opts.repoPath,
          files,
          summary: ai.summary,
          opLabel: "Sync base",
        });
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
    if (previousBranch) await tryCheckoutBranch(opts.repoPath, previousBranch);
    const wip = await restoreWipAfterMerge(opts.repoPath, wipStashMarker);
    if (wip.warning) wipWarning = wip.warning;
  }
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
  pushMergeOpHistory(job, {
    kind: kind === "merge" ? "merge" : "sync-base",
    status: "ok",
    source: source || undefined,
    target: target || undefined,
    message:
      (source && target
        ? `Conflict finalized via Chat: ${source} → ${target}`
        : `Conflict finalized via Chat`) +
      (commitSha ? ` (${commitSha.slice(0, 8)})` : "") +
      (wipWarning ? ` · ${wipWarning}` : ""),
  });
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
 * If AI cannot clear conflicts, abort and error — retry Sync base / Merge.
 */
export async function syncJobBranchWithBase(
  jobId: string,
  input: { targetBranch?: string },
  opts?: { fromQueue?: boolean },
) {
  const job = await requireJobDoc(jobId);
  let source = "";
  let target = "";
  try {
    if (
      !opts?.fromQueue &&
      (job.status === "running" || job.status === "queued")
    ) {
      throw new AppError("Job is running — stop it or wait before syncing base", 409);
    }
    source = (job.branch || job.workBranch || "").trim();
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
    target = input.targetBranch?.trim() || rt?.baseBranch?.trim() || "";
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

    if (result.commitSha && !result.alreadyUpToDate) {
      job.commitSha = result.commitSha;
      job.commitShas = [...(job.commitShas ?? []), result.commitSha].slice(-20);
      job.pendingConflictResolve = undefined;
      job.mergeError = undefined;
    }

    await assertQueuedMergeOpStillActive(job.id, "sync-base", opts?.fromQueue);

    const status = result.alreadyUpToDate ? "up_to_date" : "ok";
    const message = result.alreadyUpToDate
      ? `${source} already up to date with ${target}`
      : result.aiResolved
        ? `Pulled ${target} into ${source} — AI resolved conflicts`
        : `Pulled ${target} into ${source}`;
    pushMergeOpHistory(job, {
      kind: "sync-base",
      status,
      source,
      target,
      aiResolved: result.aiResolved || undefined,
      message:
        message +
        (result.wipWarning ? ` · ${result.wipWarning}` : ""),
      detail:
        result.aiResolved && result.summary.trim()
          ? result.summary
          : undefined,
    });
    await saveJob(job);

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
  } catch (err) {
    const msg = safeErrorMessage(err);
    if (
      opts?.fromQueue &&
      (msg.includes("Force-stopped") ||
        (err instanceof AppError && err.message.includes("Force-stopped")))
    ) {
      throw err instanceof AppError ? err : new AppError(msg, 409);
    }
    // Skip noisy history when user must pick a branch (modal flow)
    if (!msg.includes("BASE_BRANCH_NOT_SET")) {
      if (opts?.fromQueue) {
        try {
          await assertQueuedMergeOpStillActive(job.id, "sync-base", true);
        } catch (stopped) {
          throw stopped;
        }
      }
      pushMergeOpHistory(job, {
        kind: "sync-base",
        status: "error",
        source: source || undefined,
        target: target || undefined,
        message: msg,
      });
      job.mergeError = msg;
      job.pendingConflictResolve = undefined;
      await saveJob(job).catch(() => undefined);
    }
    if (err instanceof AppError) throw err;
    throw new AppError(msg, 500);
  }
}

/**
 * Merge job work branch into project/base.
 * - If an open MR already exists → accept it (never creates a new MR).
 * - Otherwise → local git merge work → base + push (no MR).
 */
export async function mergeJobBranch(
  jobId: string,
  input: { targetBranch?: string },
  opts?: { fromQueue?: boolean },
) {
  const job = await requireJobDoc(jobId);
  const statusOk =
    job.status === "awaiting_handoff" ||
    job.status === "succeeded" ||
    (Boolean(opts?.fromQueue) &&
      (job.pendingMergeOp?.restoreStatus === "awaiting_handoff" ||
        job.pendingMergeOp?.restoreStatus === "succeeded"));
  if (!statusOk) {
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
      let aiConflictResolved = false;
      let aiSummary: string | undefined;
      const { appendJobProgress } = await import(
        "../../plugins/agent/progress.js"
      );

      /** Sync base → work + AI clear conflicts, then GitLab can accept the MR. */
      const aiFixMrConflicts = async (
        reason: string,
      ): Promise<void> => {
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
        aiResolved = aiResolved || fix.aiResolved || !fix.alreadyUpToDate;
        if (fix.aiResolved) aiConflictResolved = true;
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
      await assertQueuedMergeOpStillActive(job.id, "merge", opts?.fromQueue);
      pushMergeOpHistory(job, {
        kind: "merge",
        status: "ok",
        source,
        target,
        aiResolved: aiConflictResolved || undefined,
        message:
          (merged.alreadyMerged
            ? `Already merged ${source} → ${target} (MR !${existingMr.iid})`
            : `Merged ${source} → ${target} via MR !${existingMr.iid}`) +
          (aiConflictResolved ? " — AI resolved conflicts" : "") +
          (syncError ? ` · local sync warning: ${syncError}` : ""),
        detail:
          aiConflictResolved && aiSummary?.trim() ? aiSummary : undefined,
      });
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
          jobId: job.id,
          userId: job.ownerUsername,
        });
        if (!ai.cleared) {
          const files =
            ai.files.length > 0
              ? ai.files
              : await listConflictedFiles(repoPath);
          await failConflictAfterAi({
            repoPath,
            files,
            summary: ai.summary,
            opLabel: "Merge",
          });
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
      await assertQueuedMergeOpStillActive(job.id, "merge", opts?.fromQueue);
      pushMergeOpHistory(job, {
        kind: "merge",
        status: alreadyUpToDate ? "up_to_date" : "ok",
        source,
        target,
        aiResolved: aiResolved || undefined,
        message:
          (alreadyUpToDate
            ? `${source} already up to date with ${target}`
            : `Merged ${source} → ${target}`) +
          (aiResolved ? " — AI resolved conflicts" : "") +
          (wipWarning ? ` · ${wipWarning}` : ""),
        detail:
          aiResolved && aiSummary?.trim() ? aiSummary : undefined,
      });
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
      await abortMerge(repoPath).catch(() => undefined);
      throw err;
    } finally {
      if (previousBranch) await tryCheckoutBranch(repoPath, previousBranch);
      const wip = await restoreWipAfterMerge(repoPath, wipStashMarker);
      if (wip.warning) wipWarning = wip.warning;
    }
  } catch (err) {
    const msg = safeErrorMessage(err);
    if (
      opts?.fromQueue &&
      (msg.includes("Force-stopped") ||
        (err instanceof AppError && err.message.includes("Force-stopped")))
    ) {
      throw err instanceof AppError ? err : new AppError(msg, 409);
    }
    job.mergeError = msg;
    job.pendingConflictResolve = undefined;
    if (opts?.fromQueue) {
      try {
        await assertQueuedMergeOpStillActive(job.id, "merge", true);
      } catch (stopped) {
        throw stopped;
      }
    }
    pushMergeOpHistory(job, {
      kind: "merge",
      status: "error",
      source,
      target,
      message: msg,
    });
    await saveJob(job);
    logger.warn("Merge failed", { jobId: job.id, err: msg });
    if (err instanceof AppError) throw err;
    throw new AppError(msg, MR_CONFLICT_RE.test(msg) ? 409 : 500);
  }
}
