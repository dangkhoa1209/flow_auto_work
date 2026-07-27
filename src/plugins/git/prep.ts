import { logger } from "../../logger.js";
import { resolveRepoPath } from "../../workspace/creds.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { autoWorkBranchName } from "./branch-name.js";
import { git } from "./exec.js";

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
 *   Does not create unless createWorkBranchIfMissing=true.
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
   * Default false for configured workspace work branch (must already exist).
   * Pass true for one-off hotfix/... branches.
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

  return { repoPath, branch, defaultBranch, autoCreated };
}

export async function pushBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  await git(repoPath, ["push", "-u", "origin", "HEAD:refs/heads/" + branch]);
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
