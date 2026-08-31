/**
 * Manual / auto GitLab commits + group (squash) for jobs.
 */
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import { commitMessageForIssue } from "../../plugins/agent/prompt.js";
import {
  collectCommitActions,
  softResetTo,
  syncLocalToRemoteCommit,
} from "../../plugins/git/changes-for-api.js";
import { git } from "../../plugins/git/exec.js";
import {
  commitAllTracked,
  currentBranch,
  detectDefaultBranch,
  forcePushBranch,
  getHeadSha,
  hasUncommittedChanges,
  pushBranch,
} from "../../plugins/git/prep.js";
import {
  createRepositoryCommit,
  gitlabBranchExists,
} from "../../plugins/gitlab/commits.js";
import type { JobRecord } from "../../types.js";
import { AppError } from "../../utils/AppError.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { normalizeGitProvider } from "../../workspace/types.js";
import { requireJobDoc } from "./lifecycle.js";

export type CommitMode = "manual" | "auto";

/** Default auto — only `manual` opts out. */
export function resolveCommitMode(job: JobRecord): CommitMode {
  return job.commitMode === "manual" ? "manual" : "auto";
}

export type FinalizeCommitResult = {
  commitSha: string | null;
  hasChange: boolean;
};

/**
 * GitHub: commit locally (keep agent commits) and push with PAT remote URL.
 */
async function finalizeGithubCommitForJob(
  job: JobRecord,
  repoPath: string,
  headBefore: string | null,
  commitMsg: string,
): Promise<FinalizeCommitResult> {
  const dirty = await hasUncommittedChanges(repoPath);
  const headNow = await getHeadSha(repoPath);
  const localCommits = Boolean(
    headBefore && headNow && headBefore !== headNow,
  );

  if (!dirty && !localCommits) {
    logger.info("No local changes to commit/push (GitHub)", { jobId: job.id });
    job.hasPendingChanges = false;
    return { commitSha: headNow, hasChange: false };
  }

  let commitSha = headNow;
  if (dirty) {
    const sha = await commitAllTracked(repoPath, commitMsg);
    commitSha = sha ?? (await getHeadSha(repoPath));
  }

  const branch =
    (job.branch || job.workBranch || "").trim() ||
    (await currentBranch(repoPath));

  logger.info("Pushing commit to GitHub", {
    jobId: job.id,
    branch,
    commitSha: commitSha?.slice(0, 12),
  });
  await pushBranch(repoPath, branch);

  if (commitSha) {
    job.commitSha = commitSha;
    const prev = Array.isArray(job.commitShas) ? job.commitShas : [];
    if (!prev.includes(commitSha)) {
      job.commitShas = [...prev, commitSha].slice(-20);
    } else {
      job.commitShas = prev;
    }
  }
  job.hasPendingChanges = false;
  return { commitSha: commitSha ?? null, hasChange: true };
}

/**
 * Commit dirty worktree via GitLab Commits API, or local git push for GitHub.
 * Shared by queue auto-commit and manual Commit endpoint.
 */
export async function finalizeGitlabCommitForJob(
  job: JobRecord,
  repoPath: string,
  headBefore: string | null,
  commitMsg: string,
): Promise<FinalizeCommitResult> {
  const rt = getRuntimeContext();
  if (normalizeGitProvider(rt?.gitProvider) === "github") {
    return finalizeGithubCommitForJob(job, repoPath, headBefore, commitMsg);
  }

  const headNow = await getHeadSha(repoPath);
  const dirty = await hasUncommittedChanges(repoPath);

  if (!dirty && headBefore && headNow && headBefore === headNow) {
    logger.info("No local changes to commit via GitLab API", {
      jobId: job.id,
    });
    job.hasPendingChanges = false;
    return { commitSha: headNow, hasChange: false };
  }

  if (headBefore && headNow && headBefore !== headNow) {
    logger.info("Soft-reset local commits before GitLab API commit", {
      jobId: job.id,
      headBefore: headBefore.slice(0, 12),
      headNow: headNow.slice(0, 12),
    });
    await softResetTo(repoPath, headBefore);
  }

  const actions = await collectCommitActions(repoPath);
  if (!actions.length) {
    const sha = (await getHeadSha(repoPath)) ?? headBefore;
    logger.info("Nothing to commit via GitLab API", { jobId: job.id });
    job.hasPendingChanges = false;
    return { commitSha: sha, hasChange: false };
  }

  const branch =
    (job.branch || job.workBranch || "").trim() ||
    (await currentBranch(repoPath));
  const projectIdOrPath =
    rt?.gitlabProjectId ?? rt?.gitlabPath ?? job.issue.projectId;
  if (projectIdOrPath === undefined || projectIdOrPath === "") {
    throw new Error("No GitLab project for Commits API");
  }

  const remoteExists = await gitlabBranchExists(projectIdOrPath, branch);
  let startBranch: string | undefined;
  if (!remoteExists) {
    startBranch =
      rt?.baseBranch?.trim() ||
      job.baseBranch?.trim() ||
      (await detectDefaultBranch(repoPath));
    logger.info("GitLab branch missing — creating via start_branch", {
      jobId: job.id,
      branch,
      startBranch,
    });
  }

  logger.info("Creating GitLab commit via API", {
    jobId: job.id,
    branch,
    actions: actions.length,
    remoteExists,
  });

  const created = await createRepositoryCommit({
    projectIdOrPath,
    branch,
    startBranch,
    message: commitMsg,
    actions,
    token: rt?.gitlabToken,
  });

  await syncLocalToRemoteCommit(repoPath, branch, created.id);

  const commitSha = created.id;
  job.commitSha = commitSha;
  const prev = Array.isArray(job.commitShas) ? job.commitShas : [];
  if (!prev.includes(commitSha)) {
    job.commitShas = [...prev, commitSha].slice(-20);
  } else {
    job.commitShas = prev;
  }
  job.hasPendingChanges = false;

  const stillDirty = await hasUncommittedChanges(repoPath);
  if (stillDirty) {
    logger.warn("Working tree still dirty after GitLab sync", {
      jobId: job.id,
      commitSha: commitSha.slice(0, 12),
    });
    job.hasPendingChanges = true;
  }

  return { commitSha, hasChange: true };
}

/** After agent run in manual mode: record dirty flag, do not commit. */
export async function markPendingChangesIfDirty(
  job: JobRecord,
  repoPath: string,
  headBefore: string | null,
): Promise<{ hasChange: boolean }> {
  const headNow = await getHeadSha(repoPath);
  const dirty = await hasUncommittedChanges(repoPath);
  const localCommits =
    Boolean(headBefore && headNow && headBefore !== headNow);

  const rt = getRuntimeContext();
  const isGithub = normalizeGitProvider(rt?.gitProvider) === "github";

  if (localCommits && !isGithub) {
    // Keep agent local commits as worktree changes (one soft-reset) so
    // manual Commit can ship them as a single GitLab API commit.
    await softResetTo(repoPath, headBefore!);
  }

  const stillDirty = await hasUncommittedChanges(repoPath);
  job.hasPendingChanges = stillDirty;
  if (stillDirty) {
    logger.info("Manual commit mode — deferred GitLab commit", {
      jobId: job.id,
      hadLocalCommits: localCommits,
    });
  }
  return { hasChange: stillDirty };
}

export async function setJobCommitMode(
  jobId: string,
  mode: string | undefined,
) {
  const job = await requireJobDoc(jobId);
  if (mode !== "manual" && mode !== "auto") {
    throw new AppError('commitMode must be "manual" or "auto"', 400);
  }
  job.commitMode = mode;
  await saveJob(job, { source: "commit_mode" });
  return { ok: true, job };
}

function assertSafeRepoPath(filePath: string): string {
  const p = filePath.trim().replace(/\\/g, "/");
  if (!p || p.startsWith("/") || p.includes("..") || p.includes("\0")) {
    throw new AppError(`Unsafe path: ${filePath}`, 400);
  }
  return p;
}

/**
 * Discard uncommitted changes — all, or selected paths.
 * Tracked → restore from HEAD; untracked → delete from disk.
 */
export async function discardJobChanges(
  jobId: string,
  input: { paths?: string[] } = {},
) {
  const job = await requireJobDoc(jobId);
  const rt = getRuntimeContext();
  const repoPath = rt?.repoPath?.trim();
  if (!repoPath) {
    throw new AppError("No local repo path — clone the project first", 400);
  }

  const dirty = await hasUncommittedChanges(repoPath);
  if (!dirty) {
    job.hasPendingChanges = false;
    await saveJob(job, { source: "discard_noop" });
    return { ok: true, job, discarded: [] as string[], all: true };
  }

  const paths = (input.paths || [])
    .map((p) => assertSafeRepoPath(String(p)))
    .filter(Boolean);

  if (paths.length === 0) {
    await git(repoPath, ["reset", "--hard", "HEAD"]);
    await git(repoPath, ["clean", "-fd"]);
    job.hasPendingChanges = false;
    await saveJob(job, { source: "discard_all" });
    logger.info("Discarded all uncommitted changes", { jobId: job.id });
    return { ok: true, job, discarded: [] as string[], all: true };
  }

  // Classify each path: tracked vs untracked
  const discarded: string[] = [];
  for (const filePath of paths) {
    let tracked = false;
    try {
      await git(repoPath, ["ls-files", "--error-unmatch", "--", filePath]);
      tracked = true;
    } catch {
      tracked = false;
    }

    if (tracked) {
      try {
        await git(repoPath, [
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          filePath,
        ]);
      } catch {
        // Older git without `restore`
        await git(repoPath, ["reset", "HEAD", "--", filePath]).catch(
          () => undefined,
        );
        await git(repoPath, ["checkout", "HEAD", "--", filePath]);
      }
    } else {
      // Untracked: remove file or directory
      await git(repoPath, ["clean", "-fd", "--", filePath]);
    }
    discarded.push(filePath);
  }

  const stillDirty = await hasUncommittedChanges(repoPath);
  job.hasPendingChanges = stillDirty;
  await saveJob(job, { source: "discard_paths" });
  logger.info("Discarded uncommitted paths", {
    jobId: job.id,
    discarded,
    stillDirty,
  });
  return { ok: true, job, discarded, all: false };
}

export async function commitJobManual(
  jobId: string,
  input: { message?: string },
) {
  const job = await requireJobDoc(jobId);
  const rt = getRuntimeContext();
  const repoPath = rt?.repoPath?.trim();
  if (!repoPath) {
    throw new AppError("No local repo path — clone the project first", 400);
  }

  const dirty = await hasUncommittedChanges(repoPath);
  if (!dirty && !job.hasPendingChanges) {
    throw new AppError("No pending changes to commit", 409);
  }

  const headBefore = await getHeadSha(repoPath);
  const message =
    input.message?.trim() || commitMessageForIssue(job.issue);

  try {
    const result = await finalizeGitlabCommitForJob(
      job,
      repoPath,
      headBefore,
      message,
    );
    if (!result.hasChange) {
      await saveJob(job, { source: "commit_manual" });
      throw new AppError("Nothing to commit", 409);
    }
    if (
      job.status === "awaiting_handoff" ||
      job.status === "succeeded" ||
      job.status === "draft"
    ) {
      /* keep */
    } else if (
      job.status !== "running" &&
      job.status !== "queued"
    ) {
      job.status = "awaiting_handoff";
      job.completedAt = new Date().toISOString();
    }
    await saveJob(job, { source: "commit_manual" });
    return {
      ok: true,
      job,
      commitSha: result.commitSha,
      message,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error("Manual commit failed", {
      jobId: job.id,
      err: String(err),
    });
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

/** Squash onto merge-base with base branch. */
async function resolveSquashBase(
  repoPath: string,
  job: JobRecord,
): Promise<{ sha: string; baseName: string }> {
  const rt = getRuntimeContext();
  const baseName =
    job.baseBranch?.trim() ||
    rt?.baseBranch?.trim() ||
    (await detectDefaultBranch(repoPath));

  try {
    const mb = (
      await git(repoPath, ["merge-base", `origin/${baseName}`, "HEAD"])
    ).stdout.trim();
    if (mb) return { sha: mb, baseName };
  } catch {
    /* ignore */
  }
  try {
    const mb = (
      await git(repoPath, ["merge-base", baseName, "HEAD"])
    ).stdout.trim();
    if (mb) return { sha: mb, baseName };
  } catch {
    /* ignore */
  }
  throw new AppError(
    `Could not resolve squash base (base branch: ${baseName})`,
    400,
  );
}

function buildCommitMessage(input: {
  message?: string;
  title?: string;
  body?: string;
}): string {
  const full = input.message?.trim();
  if (full) return full;
  const title = (input.title || "").trim();
  const body = (input.body || "").trim();
  if (title && body) return `${title}\n\n${body}`;
  if (title) return title;
  if (body) return body;
  return "";
}

/**
 * Squash job commits into one via local git (soft-reset → commit → force-push).
 * Avoids GitLab Commits API payload limits on large trees.
 */
export async function groupJobCommits(
  jobId: string,
  input: { message?: string; title?: string; body?: string },
) {
  const job = await requireJobDoc(jobId);
  const rt = getRuntimeContext();
  const repoPath = rt?.repoPath?.trim();
  if (!repoPath) {
    throw new AppError("No local repo path — clone the project first", 400);
  }

  if (await hasUncommittedChanges(repoPath)) {
    throw new AppError(
      "Uncommitted changes present — Commit or discard before Group",
      409,
    );
  }

  const shas = (job.commitShas || []).map((s) => s.trim()).filter(Boolean);
  if (shas.length < 2) {
    throw new AppError("Need at least 2 job commits to group", 409);
  }

  const branch = (job.branch || job.workBranch || "").trim();
  if (!branch) {
    throw new AppError("Job has no work branch", 400);
  }

  const { sha: squashBase, baseName } = await resolveSquashBase(
    repoPath,
    job,
  );

  let message = buildCommitMessage(input);
  if (!message) {
    message =
      (await git(repoPath, [
        "log",
        "-1",
        "--format=%s",
        shas[shas.length - 1]!,
      ])
        .then((r) => r.stdout.trim())
        .catch(() => "")) || commitMessageForIssue(job.issue);
  }

  logger.info("Group-commit: soft-reset + local commit + force-push", {
    jobId: job.id,
    branch,
    squashBase: squashBase.slice(0, 12),
    baseName,
    commits: shas.length,
  });

  await softResetTo(repoPath, squashBase);

  // After soft-reset, index holds the tip tree — commit creates one squash commit
  const commitSha = await commitAllTracked(repoPath, message);
  if (!commitSha) {
    throw new AppError("Nothing to group — tree matches squash base", 409);
  }

  await forcePushBranch(repoPath, branch);
  // Align local tracking ref with what we just pushed
  await syncLocalToRemoteCommit(repoPath, branch, commitSha);

  job.commitSha = commitSha;
  job.commitShas = [commitSha];
  job.hasPendingChanges = false;
  await saveJob(job, { source: "group_commit" });

  return {
    ok: true,
    job,
    commitSha,
    message,
    groupedCount: shas.length,
  };
}
