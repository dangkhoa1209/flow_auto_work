import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../config.js";
import { detectDefaultBranch } from "./prep.js";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  const repoPath = getConfig().AIHR_REPO_PATH;
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export type DiffPayload = {
  branch: string;
  base: string;
  rangeDiff: string;
  unstaged: string;
  staged: string;
  recentCommits: string;
};

/** Diff for code review in UI. */
export async function getReviewDiff(opts?: {
  issueIid?: number;
}): Promise<DiffPayload> {
  const repoPath = getConfig().AIHR_REPO_PATH;
  const { stdout: branchOut } = await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: repoPath },
  );
  const branch = branchOut.trim() || "(detached)";
  const base = await detectDefaultBranch(repoPath);

  let rangeDiff = "";
  try {
    await execFileAsync("git", ["fetch", "origin", base, "--quiet"], {
      cwd: repoPath,
    }).catch(() => undefined);
    rangeDiff = await git(["diff", `origin/${base}...HEAD`]);
  } catch {
    try {
      rangeDiff = await git(["diff", `${base}...HEAD`]);
    } catch {
      rangeDiff = "";
    }
  }

  const unstaged = await git(["diff"]);
  const staged = await git(["diff", "--cached"]);

  let recentCommits = "";
  try {
    if (opts?.issueIid) {
      recentCommits = await git([
        "log",
        "-20",
        "--oneline",
        `--grep=#${opts.issueIid}`,
      ]);
    }
    if (!recentCommits.trim()) {
      recentCommits = await git(["log", "-10", "--oneline"]);
    }
  } catch {
    recentCommits = "";
  }

  return {
    branch,
    base,
    rangeDiff,
    unstaged,
    staged,
    recentCommits,
  };
}
