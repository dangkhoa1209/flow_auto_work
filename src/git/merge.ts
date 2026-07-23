import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import { detectDefaultBranch, getHeadSha } from "./prep.js";

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

async function branchExists(repoPath: string, name: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", name]);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoPath, ["branch", "--show-current"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Checkout a branch if it exists; ignore failures (dirty tree, etc.). */
export async function tryCheckoutBranch(
  repoPath: string,
  name: string,
): Promise<boolean> {
  if (!name?.trim()) return false;
  try {
    await git(repoPath, ["checkout", name.trim()]);
    return true;
  } catch (err) {
    logger.warn("Could not restore branch after merge", {
      name,
      err: String(err),
    });
    return false;
  }
}

export async function hasDirtyWorktree(repoPath: string): Promise<boolean> {
  const { stdout } = await git(repoPath, ["status", "--porcelain"]);
  return Boolean(stdout.trim());
}

/**
 * Stash tracked + untracked WIP before branch switch.
 * Returns a unique message key to pop later (null if nothing to stash).
 */
export async function stashWipForMerge(repoPath: string): Promise<string | null> {
  if (!(await hasDirtyWorktree(repoPath))) return null;
  const marker = `flow-auto-work:merge-wip:${Date.now()}`;
  await git(repoPath, [
    "stash",
    "push",
    "-u",
    "-m",
    marker,
  ]);
  logger.info("Stashed WIP before merge", { marker });
  return marker;
}

/** Find stash@{n} by message marker. */
async function findStashRef(
  repoPath: string,
  marker: string,
): Promise<string | null> {
  const { stdout } = await git(repoPath, ["stash", "list"]);
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // stash@{0}: On branch: marker
    if (!line.includes(marker)) continue;
    const m = line.match(/^(stash@\{\d+\})/);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Restore WIP stash created by stashWipForMerge.
 * Prefer `stash pop`; on conflict leave stash intact and warn.
 */
export async function restoreWipAfterMerge(
  repoPath: string,
  marker: string | null | undefined,
): Promise<{ restored: boolean; warning?: string }> {
  if (!marker) return { restored: false };
  const ref = await findStashRef(repoPath, marker);
  if (!ref) {
    logger.warn("WIP stash not found after merge", { marker });
    return {
      restored: false,
      warning: `Không thấy stash WIP (${marker}) — kiểm tra git stash list`,
    };
  }
  try {
    await git(repoPath, ["stash", "pop", ref]);
    logger.info("Restored WIP stash after merge", { ref, marker });
    return { restored: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("stash pop had conflicts — stash kept", { ref, marker, err: msg });
    return {
      restored: false,
      warning: `WIP vẫn trong ${ref} (pop conflict). Chạy: git stash pop ${ref}`,
    };
  }
}

export async function listConflictedFiles(repoPath: string): Promise<string[]> {
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
}

export async function abortMerge(repoPath: string): Promise<void> {
  try {
    await git(repoPath, ["merge", "--abort"]);
  } catch {
    // ignore if no merge in progress
  }
}

export async function isMergeInProgress(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export type MergeAttemptResult =
  | {
      status: "merged";
      targetBranch: string;
      sourceBranch: string;
      commitSha: string | null;
      alreadyUpToDate?: boolean;
      previousBranch?: string | null;
      wipStashMarker?: string | null;
    }
  | {
      status: "conflict";
      targetBranch: string;
      sourceBranch: string;
      conflictedFiles: string[];
      previousBranch?: string | null;
      wipStashMarker?: string | null;
    };

/**
 * Stash WIP → checkout target → merge source.
 * Caller must restore branch + pop stash when done (success or fail).
 */
export async function attemptMergeIntoBase(opts: {
  repoPath: string;
  sourceBranch: string;
  targetBranch?: string;
}): Promise<MergeAttemptResult> {
  const source = opts.sourceBranch.trim();
  if (!source) throw new Error("sourceBranch required");

  const previousBranch = await getCurrentBranch(opts.repoPath);
  const wipStashMarker = await stashWipForMerge(opts.repoPath);

  const target =
    opts.targetBranch?.trim() || (await detectDefaultBranch(opts.repoPath));

  if (source === target) {
    await restoreWipAfterMerge(opts.repoPath, wipStashMarker);
    throw new Error(`Source and target are the same branch: ${source}`);
  }

  if (!(await branchExists(opts.repoPath, source))) {
    await restoreWipAfterMerge(opts.repoPath, wipStashMarker);
    throw new Error(`Source branch not found: ${source}`);
  }

  try {
    if (!(await branchExists(opts.repoPath, target))) {
      const remote = `origin/${target}`;
      if (await branchExists(opts.repoPath, remote)) {
        await git(opts.repoPath, ["checkout", "-B", target, remote]);
      } else {
        throw new Error(`Target branch not found: ${target}`);
      }
    } else {
      await git(opts.repoPath, ["checkout", target]);
    }
  } catch (err) {
    await tryCheckoutBranch(opts.repoPath, previousBranch || source);
    await restoreWipAfterMerge(opts.repoPath, wipStashMarker);
    throw err;
  }

  // Soft refresh of target tip if remote exists (ignore failures)
  try {
    await git(opts.repoPath, ["fetch", "origin", target, "--depth=50"]);
    await git(opts.repoPath, ["merge", "--ff-only", `origin/${target}`]);
  } catch {
    // offline / no remote / diverged — continue with local target
  }

  // Sync source from origin so GitLab-API commits are visible locally
  try {
    await git(opts.repoPath, [
      "fetch",
      "origin",
      `+refs/heads/${source}:refs/remotes/origin/${source}`,
    ]);
    if (await branchExists(opts.repoPath, `origin/${source}`)) {
      await git(opts.repoPath, ["branch", "-f", source, `origin/${source}`]);
      logger.info("Updated local source branch from origin", { source });
    }
  } catch (err) {
    logger.warn("Could not fetch source branch from origin before merge", {
      source,
      err: String(err),
    });
  }

  try {
    const { stdout } = await git(opts.repoPath, [
      "merge",
      "--no-ff",
      "-m",
      `Merge branch '${source}' into ${target}`,
      source,
    ]);
    const already = /Already up to date/i.test(stdout);
    const sha = await getHeadSha(opts.repoPath);
    logger.info("Merge succeeded", { source, target, sha, already });
    return {
      status: "merged",
      targetBranch: target,
      sourceBranch: source,
      commitSha: sha,
      alreadyUpToDate: already,
      previousBranch,
      wipStashMarker,
    };
  } catch (err) {
    const conflicted = await listConflictedFiles(opts.repoPath);
    if (conflicted.length === 0 && !(await isMergeInProgress(opts.repoPath))) {
      await abortMerge(opts.repoPath).catch(() => undefined);
      await tryCheckoutBranch(opts.repoPath, previousBranch || source);
      await restoreWipAfterMerge(opts.repoPath, wipStashMarker);
      throw err instanceof Error ? err : new Error(String(err));
    }
    logger.warn("Merge conflict", { source, target, conflicted });
    return {
      status: "conflict",
      targetBranch: target,
      sourceBranch: source,
      conflictedFiles: conflicted,
      previousBranch,
      wipStashMarker,
    };
  }
}

/** After AI fixed conflict markers: stage all & complete the merge commit. */
export async function finalizeMergeCommit(
  repoPath: string,
  message: string,
): Promise<string | null> {
  const still = await listConflictedFiles(repoPath);
  if (still.length) {
    throw new Error(`Still conflicted: ${still.join(", ")}`);
  }
  await git(repoPath, ["add", "-A"]);
  if (await isMergeInProgress(repoPath)) {
    await git(repoPath, ["commit", "-m", message]);
  } else {
    const { stdout } = await git(repoPath, ["status", "--porcelain"]);
    if (stdout.trim()) {
      await git(repoPath, ["commit", "-m", message]);
    }
  }
  return getHeadSha(repoPath);
}
