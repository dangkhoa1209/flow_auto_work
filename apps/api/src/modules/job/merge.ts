/**
 * Handoff + merge: apply GitLab issue actions, merge work branch via MR API.
 * On MR conflicts, the Cursor agent resolves them locally and the MR is retried.
 */
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import type { IssueJob } from "../../types.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobDoc } from "./lifecycle.js";
import {
  buildTaskChangeText,
  listTaskCommitSubjects,
} from "./taskChangeSummary.js";

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

function buildMergeIssueComment(opts: {
  issueTitle: string;
  changeText?: string;
  source: string;
  target: string;
  commitSha?: string | null;
  mrUrl?: string | null;
}): string {
  const change =
    opts.changeText?.trim() ||
    (opts.issueTitle
      ? `Đã merge: ${opts.issueTitle}`
      : "Đã merge thay đổi từ nhánh work vào base.");
  const lines = [
    `## Thay đổi`,
    ``,
    change,
    ``,
    `## Merge`,
    ``,
    `- \`${opts.source}\` → \`${opts.target}\``,
  ];
  if (opts.commitSha) {
    lines.push(`- Commit: \`${opts.commitSha.slice(0, 12)}\``);
  }
  if (opts.mrUrl) {
    lines.push(`- MR: ${opts.mrUrl}`);
  }
  lines.push(
    ``,
    `## Testcase`,
    ``,
    `1. Pull nhánh \`${opts.target}\` và kiểm tra diff / hành vi đúng scope`,
    `2. Verify chức năng liên quan issue vẫn hoạt động`,
    `3. Regression nhanh các flow chính bị ảnh hưởng`,
  );
  return lines.join("\n");
}

/** Best-effort summary comment on the GitLab issue after a successful Merge. */
async function postMergeSummaryComment(
  job: Awaited<ReturnType<typeof requireJobDoc>>,
  opts: {
    source: string;
    target: string;
    commitSha?: string | null;
    mrUrl?: string | null;
    /** Collected before merge — after merge base..work is often empty. */
    commitSubjects?: string[];
    repoPath?: string;
  },
): Promise<void> {
  const iid = job.issue?.issueIid ?? 0;
  if (iid <= 0) return;
  try {
    const { commentOnIssue } = await import("../../plugins/scm/index.js");
    const { withAiGeneratedMarker } = await import(
      "../../plugins/gitlab/agent-comment.js"
    );

    let commitSubjects = opts.commitSubjects ?? [];
    if (!commitSubjects.length && opts.repoPath) {
      commitSubjects = await listTaskCommitSubjects({
        repoPath: opts.repoPath,
        sourceBranch: opts.source,
        targetBranch: opts.target,
      });
    }

    const changeText = buildTaskChangeText({
      issueTitle: job.issue.title || "",
      jobSummary: job.summary,
      commitSubjects,
      fallback: "Đã merge thay đổi từ nhánh work vào base.",
    });

    await commentOnIssue(
      job.issue.projectId,
      iid,
      withAiGeneratedMarker(
        buildMergeIssueComment({
          issueTitle: job.issue.title || "",
          changeText,
          source: opts.source,
          target: opts.target,
          commitSha: opts.commitSha,
          mrUrl: opts.mrUrl,
        }),
      ),
    );
  } catch (err) {
    logger.warn("Merge ok but issue summary comment failed", {
      jobId: job.id,
      iid,
      err: String(err),
    });
  }
}

export type PullBaseResult = {
  summary: string;
  aiResolved: boolean;
  alreadyUpToDate: boolean;
  commitSha: string | null;
  wipWarning?: string;
};

/**
 * Pull latest base (target) INTO the job work branch:
 * stash WIP → fetch origin → merge target into work branch → Cursor agent
 * clears conflict markers if any → commit + push work branch → restore WIP.
 * Base branch is never pushed directly (it is often protected).
 * Used by the Sync-base button and as MR-conflict auto-fix during merge.
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
  } = await import("../../plugins/git/merge.js");
  const { pushBranch } = await import("../../plugins/git/prep.js");
  const { resolveMergeConflictsWithAi } = await import(
    "../../plugins/agent/merge-resolve.js"
  );

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
      let files = attempt.conflictedFiles;
      let text = "";
      // Up to 2 rounds of AI resolution before giving up
      for (let round = 0; round < 2 && files.length; round++) {
        const resolved = await resolveMergeConflictsWithAi({
          sourceBranch: opts.target,
          targetBranch: opts.source,
          conflictedFiles: files,
          issue: opts.issue,
        });
        text = text ? `${text}\n---\n${resolved.text}` : resolved.text;
        files = resolved.remaining;
      }
      if (files.length) {
        await abortMerge(opts.repoPath).catch(() => undefined);
        throw new AppError(
          `AI could not clear conflicts: ${files.join(", ")}`,
          409,
        );
      }
      aiResolved = true;
      summary = text || "(resolved)";
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
  } finally {
    if (previousBranch) await tryCheckoutBranch(opts.repoPath, previousBranch);
    const wip = await restoreWipAfterMerge(opts.repoPath, wipStashMarker);
    if (wip.warning) wipWarning = wip.warning;
  }
}

/**
 * Sync-base button: pull latest base branch into the job work branch.
 * Stash WIP → pull → AI-fix conflicts if any → push work branch → unstash.
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

  // Settings project branch wins — job.baseBranch is a stale snapshot and the
  // GitLab default branch is a guess. No setting → user must pick explicitly.
  const target = input.targetBranch?.trim() || rt?.baseBranch?.trim() || "";
  if (!target) {
    throw new AppError(
      "BASE_BRANCH_NOT_SET: Project chưa cấu hình Main branch — chọn nhánh nguồn để pull",
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
  await saveJob(job);

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

      // Snapshot task commits BEFORE accept — after merge base..work is empty.
      const commitSubjects = repoPath
        ? await listTaskCommitSubjects({
            repoPath,
            sourceBranch: source,
            targetBranch: target,
            commitShas: job.commitShas,
          })
        : [];

      /** Sync base → work + AI clear conflicts, then GitLab can accept the MR. */
      const aiFixMrConflicts = async (reason: string) => {
        if (!repoPath) {
          throw new AppError(
            "MR đang conflict nhưng không có local repo để AI auto-fix — gắn project clone hoặc Sync base thủ công",
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
          "MR conflict — AI đang resolve (như Sync base)…",
        );
        const fix = await pullBaseIntoWorkBranch({
          repoPath,
          source,
          target,
          issue: job.issue,
        });
        aiResolved = aiResolved || fix.aiResolved || !fix.alreadyUpToDate;
        aiSummary = fix.summary;
        appendJobProgress(
          job.id,
          "status",
          fix.aiResolved
            ? "AI đã resolve conflict — thử accept MR lại"
            : "Đã sync base vào work — thử accept MR lại",
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

      await postMergeSummaryComment(job, {
        source,
        target,
        commitSha: mergeSha,
        mrUrl: merged.webUrl || existingMr.webUrl,
        commitSubjects,
        repoPath,
      });

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
        "Chưa có open MR và không có local repo để merge trực tiếp. Bấm Create MR trước, hoặc gắn project clone.",
        409,
      );
    }

    const {
      attemptMergeIntoBase,
      abortMerge,
      finalizeMergeCommit,
      tryCheckoutBranch,
      restoreWipAfterMerge,
    } = await import("../../plugins/git/merge.js");
    const { pushBranch } = await import("../../plugins/git/prep.js");
    const { resolveMergeConflictsWithAi } = await import(
      "../../plugins/agent/merge-resolve.js"
    );

    // Snapshot before local merge mutates base.
    const commitSubjects = await listTaskCommitSubjects({
      repoPath,
      sourceBranch: source,
      targetBranch: target,
      commitShas: job.commitShas,
    });

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
          "Merge conflict — AI đang resolve (như Sync base)…",
        );
        let files = attempt.conflictedFiles;
        let text = "";
        for (let round = 0; round < 2 && files.length; round++) {
          const resolved = await resolveMergeConflictsWithAi({
            sourceBranch: source,
            targetBranch: target,
            conflictedFiles: files,
            issue: job.issue,
          });
          text = text ? `${text}\n---\n${resolved.text}` : resolved.text;
          files = resolved.remaining;
        }
        if (files.length) {
          await abortMerge(repoPath).catch(() => undefined);
          throw new AppError(
            `AI could not clear conflicts: ${files.join(", ")}`,
            409,
          );
        }
        aiResolved = true;
        aiSummary = text || "(resolved)";
        appendJobProgress(job.id, "status", "AI đã resolve conflict — finalize merge");
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
      job.mergePushedAt = new Date().toISOString();
      job.mergePushError = undefined;
      if (commitSha) {
        job.commitSha = commitSha;
        job.commitShas = [...(job.commitShas ?? []), commitSha].slice(-20);
      }
      await saveJob(job);

      await postMergeSummaryComment(job, {
        source,
        target,
        commitSha,
        mrUrl: null,
        commitSubjects,
        repoPath,
      });

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
    } finally {
      if (previousBranch) await tryCheckoutBranch(repoPath, previousBranch);
      const wip = await restoreWipAfterMerge(repoPath, wipStashMarker);
      if (wip.warning) wipWarning = wip.warning;
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
