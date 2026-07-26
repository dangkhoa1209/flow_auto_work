import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  collectCommitActions,
  syncLocalToRemoteCommit,
} from "./changes-for-api.js";
import { createRepositoryCommit } from "../gitlab/commits.js";
import { logger } from "../../logger.js";
import { hasUncommittedChanges } from "./prep.js";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function gitOk(
  repoPath: string,
  args: string[],
): Promise<string | null> {
  try {
    return await git(repoPath, args);
  } catch {
    return null;
  }
}

/**
 * Revert a commit on the job branch via local `git revert` + GitLab Commits API.
 */
export async function revertCommitViaGitlab(opts: {
  repoPath: string;
  branch: string;
  sha: string;
  projectIdOrPath: number | string;
  token?: string;
  message?: string;
}): Promise<{ commitSha: string; message: string }> {
  const branch = opts.branch.trim();
  const sha = opts.sha.trim();
  if (!branch) throw new Error("branch required to revert");
  if (!sha) throw new Error("commit sha required");

  if (await hasUncommittedChanges(opts.repoPath)) {
    throw new Error(
      "Working tree dirty — commit or stash local changes before reverting",
    );
  }

  // Sync tip from origin
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  await git(opts.repoPath, ["fetch", "origin", refspec]).catch(async () => {
    await git(opts.repoPath, ["fetch", "origin", sha]);
  });

  const tip =
    (await gitOk(opts.repoPath, ["rev-parse", `origin/${branch}`]))?.trim() ||
    (await gitOk(opts.repoPath, ["rev-parse", branch]))?.trim();
  if (!tip) throw new Error(`Branch not found: ${branch}`);

  await git(opts.repoPath, ["checkout", "-B", branch, tip]);

  const fullSha =
    (await gitOk(opts.repoPath, ["rev-parse", sha]))?.trim() || sha;
  const subject =
    (
      await gitOk(opts.repoPath, ["log", "-1", "--format=%s", fullSha])
    )?.trim() || fullSha.slice(0, 8);

  // Abort any leftover revert
  await gitOk(opts.repoPath, ["revert", "--abort"]);

  try {
    await git(opts.repoPath, [
      "revert",
      "--no-commit",
      "--no-edit",
      fullSha,
    ]);
  } catch (err) {
    await gitOk(opts.repoPath, ["revert", "--abort"]);
    await gitOk(opts.repoPath, ["reset", "--hard", tip]);
    throw new Error(
      `Revert conflict or failed for ${fullSha.slice(0, 8)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const actions = await collectCommitActions(opts.repoPath);
  if (!actions.length) {
    await gitOk(opts.repoPath, ["revert", "--abort"]);
    await gitOk(opts.repoPath, ["reset", "--hard", tip]);
    throw new Error("Revert produced no changes (may already be reverted)");
  }

  const message =
    opts.message?.trim() ||
    `Revert "${subject}"\n\nThis reverts commit ${fullSha}.`;

  logger.info("Creating revert commit via GitLab API", {
    branch,
    sha: fullSha.slice(0, 12),
    actions: actions.length,
  });

  const created = await createRepositoryCommit({
    projectIdOrPath: opts.projectIdOrPath,
    branch,
    message,
    actions,
    token: opts.token,
  });

  await syncLocalToRemoteCommit(opts.repoPath, branch, created.id);

  return { commitSha: created.id, message };
}
