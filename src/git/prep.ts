import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { resolveRepoPath } from "../workspace/creds.js";
import { getRuntimeContext } from "../workspace/runtime.js";
import { autoWorkBranchName } from "./branch-name.js";

const execFileAsync = promisify(execFile);

async function git(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024,
  });
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
 * - If workBranch set: checkout & stay on that branch (create from projectBranch if missing).
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
    // Fixed work branch: only work here
    if (await branchExists(repoPath, workBranch)) {
      await checkoutBranch(repoPath, workBranch);
    } else {
      await createBranchFromBase(repoPath, workBranch, projectBranch);
      autoCreated = true;
    }
    branch = workBranch;
    logger.info("Using fixed work branch", {
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

function parsePorcelainPaths(porcelain: string): string[] {
  return porcelain
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^.. (.+)$/);
      if (!m?.[1]) return "";
      let path = m[1].trim();
      const arrow = path.lastIndexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4).trim();
      return path.replace(/^"(.*)"$/, "$1").trim();
    })
    .filter(Boolean);
}

function isExcludedPath(filePath: string, excluded: string[]): boolean {
  const normalized = filePath.replace(/^\.\//, "").replace(/\\/g, "/");
  return excluded.some((ex) => {
    const e = ex.replace(/^\.\//, "").replace(/\\/g, "/");
    return normalized === e || normalized.endsWith("/" + e);
  });
}

/** True if there are uncommitted changes outside COMMIT_EXCLUDE_PATHS. */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const excluded = getConfig().commitExcludePaths;
  const { stdout } = await git(repoPath, ["status", "--porcelain"]);
  const paths = parsePorcelainPaths(stdout);
  return paths.some((p) => !isExcludedPath(p, excluded));
}

/**
 * Ensure excluded WIP files are not in the latest commit (not gitignored).
 */
export async function scrubExcludedPathsFromLastCommit(
  repoPath: string,
): Promise<void> {
  const excluded = getConfig().commitExcludePaths;
  if (excluded.length === 0) return;

  try {
    await git(repoPath, ["restore", "--staged", "--", ...excluded]);
  } catch {
    // ignore
  }

  let headFiles: string[] = [];
  try {
    const { stdout } = await git(repoPath, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "HEAD",
    ]);
    headFiles = stdout
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return;
  }

  const hit = headFiles.filter((f) => isExcludedPath(f, excluded));
  if (hit.length === 0) return;

  logger.warn("Removing excluded paths from last commit (keeping as local WIP)", {
    hit,
  });

  const { stdout: msg } = await git(repoPath, ["log", "-1", "--pretty=%B"]);
  await git(repoPath, ["reset", "--soft", "HEAD~1"]);
  await git(repoPath, ["restore", "--staged", "--", ...hit]);
  const { stdout: staged } = await git(repoPath, [
    "diff",
    "--cached",
    "--name-only",
  ]);
  if (!staged.trim()) {
    logger.warn("After scrub, no other staged files — no commit left to recreate");
    return;
  }
  await git(repoPath, ["commit", "-m", msg.trim()]);
}

/** Stage all (minus COMMIT_EXCLUDE_PATHS) and commit. Returns new HEAD SHA, or null if nothing to commit. */
export async function commitAllTracked(
  repoPath: string,
  message: string,
): Promise<string | null> {
  await git(repoPath, ["add", "-A"]);
  const excluded = getConfig().commitExcludePaths;
  if (excluded.length) {
    try {
      await git(repoPath, ["restore", "--staged", "--", ...excluded]);
    } catch {
      // ignore
    }
  }
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
