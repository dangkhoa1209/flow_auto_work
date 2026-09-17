import { logger } from "../../logger.js";
import {
  buildCloneUrl,
  gitHttpAuthEnvFromCloneUrl,
  stripCloneUrlCredentials,
} from "../../workspace/clone.js";
import { resolveRepoPath } from "../../workspace/creds.js";
import { scheduleProjectGraphify } from "../../workspace/graphify.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { autoWorkBranchName } from "./branch-name.js";
import { git } from "./exec.js";
import { redactGitCredentials } from "./redact.js";

/**
 * Push remote URL with current runtime PAT (same scheme as clone).
 * Avoids relying on a stale `origin` that may lack / have an old token.
 */
function resolvePatPushUrl(): string {
  const rt = getRuntimeContext();
  const token = rt?.gitlabToken?.trim();
  const gitlabPath = rt?.gitlabPath?.trim();
  if (!rt || !token || !gitlabPath) {
    throw new Error(
      "No remote PAT in runtime — cannot push (clone/login with token first)",
    );
  }
  const host = rt.gitlabHost || "https://gitlab.com";
  return buildCloneUrl({
    provider: rt.gitProvider,
    host,
    token,
    path: gitlabPath,
  });
}

function isTransientGitNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Couldn't connect to server|Failed to connect|Could not resolve host|Connection timed out|SSL connection timeout|Operation timed out|Network is unreachable|Temporary failure in name resolution|recv failure|gnutls_handshake|OpenSSL SSL_connect|unable to access/i.test(
    msg,
  );
}

/** Remote tip moved / diverged — push would rewrite history without --force. */
export function isNonFastForwardPushError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /non-fast-forward|tip of your current branch is behind|\[rejected\].*\(fetch first\)/i.test(
    msg,
  );
}

/**
 * Stale MERGE_HEAD on another branch (e.g. leftover Sync/Merge on base) must
 * not block Chat/Run that expects the job work branch.
 */
export function shouldAbortMergeForWorkBranch(
  currentBranch: string,
  desiredWorkBranch: string | undefined,
): boolean {
  const current = currentBranch.trim();
  const desired = desiredWorkBranch?.trim() || "";
  return Boolean(desired && current && desired !== current);
}

/**
 * Rewrite opaque push/auth rejects into actionable Settings / policy hints.
 * Leaves non-fast-forward and unrelated errors unchanged (aside from redact).
 */
export function clarifyGitRemoteError(err: unknown, branch?: string): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = redactGitCredentials(raw);
  const branchHint = branch?.trim() ? ` (branch \`${branch.trim()}\`)` : "";

  if (
    /protected branch|You are not allowed to push|push is not permitted|pre-receive hook declined|GH006|cannot push.*protected|protected branches can only be/i.test(
      msg,
    )
  ) {
    return new Error(
      `Push rejected by remote policy${branchHint} (protected branch or missing push permission). Use Merge via MR, or update PAT role / branch protection. ${msg.slice(0, 280)}`,
    );
  }
  if (
    /HTTP Basic:\s*Access denied|Authentication failed|could not read Username|Invalid username or password|terminal prompts disabled|401 Unauthorized|The requested URL returned error:\s*403/i.test(
      msg,
    )
  ) {
    return new Error(
      `Git authentication failed${branchHint} — refresh the project PAT in Settings → Project (expired token or missing write/api scope). ${msg.slice(0, 280)}`,
    );
  }
  if (err instanceof Error) {
    err.message = msg;
    return err;
  }
  return new Error(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch remote branch tip (PAT URL, same as push) and merge into HEAD.
 * No force — creates a merge commit when histories diverged.
 */
async function integrateRemoteBranchTip(
  repoPath: string,
  branch: string,
): Promise<void> {
  const patUrl = resolvePatPushUrl();
  const publicUrl = stripCloneUrlCredentials(patUrl);
  const authEnv = gitHttpAuthEnvFromCloneUrl(patUrl);
  try {
    await git(
      repoPath,
      [
        "fetch",
        publicUrl,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      undefined,
      authEnv,
    );
  } catch {
    await git(repoPath, [
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
  }

  try {
    await git(repoPath, ["rev-parse", "--verify", `origin/${branch}`]);
  } catch {
    throw new Error(
      `Push rejected (non-fast-forward) but origin/${branch} is missing after fetch`,
    );
  }

  try {
    await git(repoPath, [
      "merge",
      "-m",
      `Merge remote-tracking branch 'origin/${branch}'`,
      `origin/${branch}`,
    ]);
  } catch (err) {
    const conflicted = await listConflictedFilesForPush(repoPath);
    try {
      await git(repoPath, ["merge", "--abort"]);
    } catch {
      /* no MERGE_HEAD */
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (conflicted.length > 0 || /CONFLICT|conflict/i.test(msg)) {
      throw new Error(
        `Push rejected (non-fast-forward). Merging origin/${branch} into local had conflicts` +
          (conflicted.length
            ? ` (${conflicted.slice(0, 8).join(", ")})`
            : "") +
          " — resolve via Sync base / Chat, then retry.",
      );
    }
    throw new Error(
      `Push rejected (non-fast-forward). Could not merge origin/${branch}: ${msg.slice(0, 400)}`,
    );
  }
}

async function listConflictedFilesForPush(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await git(repoPath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    return stdout
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Push with PAT in env (not argv) + retry on transient GitHub/GitLab network errors. */
async function pushWithPatUrl(
  repoPath: string,
  branch: string,
  force: boolean,
): Promise<void> {
  const patUrl = resolvePatPushUrl();
  const publicUrl = stripCloneUrlCredentials(patUrl);
  const authEnv = gitHttpAuthEnvFromCloneUrl(patUrl);
  const args = force
    ? ["push", "--force", publicUrl, `HEAD:refs/heads/${branch}`]
    : ["push", publicUrl, `HEAD:refs/heads/${branch}`];

  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await git(repoPath, args, undefined, authEnv);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientGitNetworkError(err) || attempt === maxAttempts) {
        throw err;
      }
      logger.warn("git push network failure — retrying", {
        branch,
        force,
        attempt,
        maxAttempts,
        err: err instanceof Error ? err.message.slice(0, 240) : String(err),
      });
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

/** Full HEAD SHA, or null if unavailable */
export async function getHeadSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoPath, ["rev-parse", "HEAD"]);
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await git(repoPath, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    const ref = stdout.trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch {
    // fall through
  }
  for (const candidate of ["main", "master", "develop"]) {
    try {
      await git(repoPath, ["rev-parse", "--verify", `origin/${candidate}`]);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error("Could not detect default branch");
}

export async function currentBranch(repoPath: string): Promise<string> {
  const { stdout } = await git(repoPath, ["branch", "--show-current"]);
  const branch = stdout.trim();
  if (!branch) {
    throw new Error("Detached HEAD — checkout a branch before auto-work");
  }
  return branch;
}

async function branchExists(repoPath: string, name: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", name]);
    return true;
  } catch {
    return false;
  }
}

async function checkoutBranch(repoPath: string, name: string): Promise<void> {
  await git(repoPath, ["checkout", name]);
}

/**
 * Create branch from base (local or origin/base), checkout it.
 */
async function createBranchFromBase(
  repoPath: string,
  newBranch: string,
  baseBranch: string,
): Promise<void> {
  // Prefer local base, else origin/base
  let startPoint = baseBranch;
  if (!(await branchExists(repoPath, baseBranch))) {
    const remote = `origin/${baseBranch}`;
    if (await branchExists(repoPath, remote)) {
      startPoint = remote;
    } else {
      throw new Error(
        `Project branch "${baseBranch}" not found locally or on origin`,
      );
    }
  }
  await git(repoPath, ["checkout", "-B", newBranch, startPoint]);
}

export type PreparedRepo = {
  repoPath: string;
  branch: string;
  defaultBranch: string;
  /** true if we auto-created feat/<iid>/slug */
  autoCreated?: boolean;
};

/**
 * - If workBranch set: checkout existing work branch (local or origin).
 *   If missing and createWorkBranchIfMissing=true, create from base/Main.
 * - If workBranch empty: create feat/<iid>/<slug> from projectBranch (or default).
 */
export async function prepareRepoForIssue(opts: {
  issueIid: number;
  title: string;
  targetBranchOverride?: string;
  /** Explicit work branch — commit only here */
  workBranch?: string;
  /** Base / project branch to fork from when auto-creating */
  baseBranch?: string;
  repoPath?: string;
  /**
   * When using workBranch: if missing locally/on origin, create from base.
   * Default false; Flow queue passes true so a configured Work branch can
   * be created from Main on first Run.
   */
  createWorkBranchIfMissing?: boolean;
}): Promise<PreparedRepo> {
  const repoPath = opts.repoPath?.trim() || resolveRepoPath();
  const rt = getRuntimeContext();
  const defaultBranch =
    opts.targetBranchOverride || (await detectDefaultBranch(repoPath));
  const projectBranch =
    opts.baseBranch?.trim() ||
    rt?.baseBranch?.trim() ||
    defaultBranch;
  const workBranch =
    opts.workBranch?.trim() || rt?.workBranch?.trim() || undefined;

  const { stdout: status } = await git(repoPath, ["status", "--porcelain"]);
  if (status.trim()) {
    logger.warn("Working tree has local changes — keeping them on branch", {
      issueIid: opts.issueIid,
      files: status.trim().split("\n").slice(0, 20),
    });
  }

  // Open merge: keep only when it is already on the job work branch (Chat
  // recovery). Wrong-branch leftovers (e.g. MERGE_HEAD on main) → abort then
  // continue with normal work checkout — do not block Chat/Run.
  const { isMergeInProgress, getCurrentBranch, abortMerge } = await import(
    "./merge.js"
  );
  if (await isMergeInProgress(repoPath)) {
    const current = (await getCurrentBranch(repoPath))?.trim() || "";
    const desired =
      workBranch?.trim() ||
      (current ? "" : autoWorkBranchName(opts.issueIid, opts.title));
    if (shouldAbortMergeForWorkBranch(current, desired)) {
      logger.warn("Aborting stale merge on wrong branch before work checkout", {
        current,
        desired,
        issueIid: opts.issueIid,
      });
      await abortMerge(repoPath);
      if (await isMergeInProgress(repoPath)) {
        throw new Error(
          `Stale merge on "${current}" (job expects "${desired}") could not be aborted. ` +
            `In the clone run: git merge --abort, then retry Chat / Sync base.`,
        );
      }
      // Fall through to normal checkout of desired work branch.
    } else {
      const branch = current || desired || projectBranch;
      logger.info("Keeping open merge for chat conflict resolve", {
        branch,
        issueIid: opts.issueIid,
      });
      scheduleProjectGraphify(repoPath, "work-prep");
      return { repoPath, branch, defaultBranch, autoCreated: false };
    }
  }

  let branch: string;
  let autoCreated = false;

  if (workBranch) {
    if (await branchExists(repoPath, workBranch)) {
      await checkoutBranch(repoPath, workBranch);
    } else if (await branchExists(repoPath, `origin/${workBranch}`)) {
      await git(repoPath, [
        "checkout",
        "-b",
        workBranch,
        "--track",
        `origin/${workBranch}`,
      ]);
    } else if (opts.createWorkBranchIfMissing) {
      await createBranchFromBase(repoPath, workBranch, projectBranch);
      autoCreated = true;
    } else {
      throw new Error(
        `Work branch "${workBranch}" does not exist (local/origin). Create this branch first, or clear Work branch in Settings → Project.`,
      );
    }
    branch = workBranch;
    logger.info("Using work branch", {
      branch,
      projectBranch,
      issueIid: opts.issueIid,
      created: autoCreated,
    });
  } else {
    // Auto feat/<iid>/<slug> from project branch
    const auto = autoWorkBranchName(opts.issueIid, opts.title);
    if (await branchExists(repoPath, auto)) {
      await checkoutBranch(repoPath, auto);
    } else {
      await createBranchFromBase(repoPath, auto, projectBranch);
      autoCreated = true;
    }
    branch = auto;
    logger.info("Using auto feat branch", {
      branch,
      projectBranch,
      issueIid: opts.issueIid,
      created: autoCreated,
    });
  }

  // Incremental graphify for this checkout only (not other projects).
  scheduleProjectGraphify(repoPath, "work-prep");

  return { repoPath, branch, defaultBranch, autoCreated };
}

export async function pushBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  // One-shot auth via env — do not `push -u` (would write token into branch.*.remote).
  // On non-fast-forward (remote moved / client pushed same branch), fetch + merge
  // remote tip into HEAD (no force) and retry — covers Sync base, Merge, commit.
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pushWithPatUrl(repoPath, branch, false);
      await refreshOriginBranchRef(repoPath, branch);
      return;
    } catch (err) {
      lastErr = err;
      if (!isNonFastForwardPushError(err) || attempt === maxAttempts) {
        throw clarifyGitRemoteError(err, branch);
      }
      logger.warn("git push non-fast-forward — integrating remote tip and retrying", {
        branch,
        attempt,
        maxAttempts,
        err: err instanceof Error ? err.message.slice(0, 240) : String(err),
      });
      try {
        await integrateRemoteBranchTip(repoPath, branch);
      } catch (integrateErr) {
        throw clarifyGitRemoteError(integrateErr, branch);
      }
    }
  }
  throw clarifyGitRemoteError(lastErr, branch);
}

/** Force-push current HEAD using runtime GitLab PAT (history rewrite / squash). */
export async function forcePushBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  try {
    await pushWithPatUrl(repoPath, branch, true);
    await refreshOriginBranchRef(repoPath, branch);
  } catch (err) {
    throw clarifyGitRemoteError(err, branch);
  }
}

async function refreshOriginBranchRef(
  repoPath: string,
  branch: string,
): Promise<void> {
  try {
    await git(repoPath, [
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    await git(repoPath, ["branch", `--set-upstream-to=origin/${branch}`, branch]);
  } catch {
    /* tracking refresh is best-effort */
  }
}

/** True if there are uncommitted changes. */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const { stdout } = await git(repoPath, ["status", "--porcelain"]);
  return Boolean(stdout.trim());
}

/** Stage all and commit. Returns new HEAD SHA, or null if nothing to commit. */
export async function commitAllTracked(
  repoPath: string,
  message: string,
): Promise<string | null> {
  await git(repoPath, ["add", "-A"]);
  const { stdout: staged } = await git(repoPath, [
    "diff",
    "--cached",
    "--name-only",
  ]);
  if (!staged.trim()) {
    return null;
  }
  await git(repoPath, ["commit", "-m", message]);
  return getHeadSha(repoPath);
}
