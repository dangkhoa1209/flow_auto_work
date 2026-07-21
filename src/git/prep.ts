import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";

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

export type PreparedRepo = {
  repoPath: string;
  branch: string;
  defaultBranch: string;
};

/**
 * Stay on the current local branch (e.g. bugs/dangkhoa/ykk/some-bugs).
 * Do not checkout main / create auto/* branches / stash.
 */
export async function prepareRepoForIssue(opts: {
  issueIid: number;
  title: string;
  targetBranchOverride?: string;
}): Promise<PreparedRepo> {
  const repoPath = getConfig().AIHR_REPO_PATH;
  const branch = await currentBranch(repoPath);
  const defaultBranch =
    opts.targetBranchOverride || (await detectDefaultBranch(repoPath));

  const { stdout: status } = await git(repoPath, ["status", "--porcelain"]);
  if (status.trim()) {
    logger.warn("Working tree has local changes — keeping them on current branch", {
      branch,
      issueIid: opts.issueIid,
      files: status.trim().split("\n").slice(0, 20),
    });
  }

  logger.info("Using current branch (no checkout)", {
    branch,
    defaultBranch,
    issueIid: opts.issueIid,
  });

  return { repoPath, branch, defaultBranch };
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
      // Always "XY PATH" (2 status chars + space). Renames: "XY old -> new".
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
 * If HEAD includes them, rewrite that local commit without those paths.
 * Leaves the files as local modifications on disk.
 */
export async function scrubExcludedPathsFromLastCommit(
  repoPath: string,
): Promise<void> {
  const excluded = getConfig().commitExcludePaths;
  if (excluded.length === 0) return;

  // Unstage excluded paths if staged
  try {
    await git(repoPath, ["restore", "--staged", "--", ...excluded]);
  } catch {
    // ignore if not staged / not present
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
  // Keep working tree versions; unstage only. Re-commit remaining staged files.
  const { stdout: staged } = await git(repoPath, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) {
    // Nothing else to commit — leave soft-reset state with only excluded dirty files
    logger.warn("After scrub, no other staged files — no commit left to recreate");
    return;
  }
  await git(repoPath, ["commit", "-m", msg.trim()]);
}

/** Stage all (minus COMMIT_EXCLUDE_PATHS) and commit. Returns false if nothing to commit. */
export async function commitAllTracked(
  repoPath: string,
  message: string,
): Promise<boolean> {
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
    return false;
  }
  await git(repoPath, ["commit", "-m", message]);
  return true;
}
