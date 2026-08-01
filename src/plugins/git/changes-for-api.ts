import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitlabCommitAction } from "../gitlab/commits.js";
import { logger } from "../../logger.js";
import { git } from "./exec.js";

function isBinaryBuffer(buf: Buffer): boolean {
  return buf.includes(0);
}

async function fileActionContent(
  repoPath: string,
  relPath: string,
): Promise<Pick<GitlabCommitAction, "content" | "encoding">> {
  const abs = path.join(repoPath, relPath);
  const buf = await readFile(abs);
  if (isBinaryBuffer(buf)) {
    return { content: buf.toString("base64"), encoding: "base64" };
  }
  return { content: buf.toString("utf8"), encoding: "text" };
}

/**
 * Stage everything and map cached diff → GitLab Commits API actions.
 * Returns empty array when there is nothing to commit.
 */
export async function collectCommitActions(
  repoPath: string,
): Promise<GitlabCommitAction[]> {
  await git(repoPath, ["add", "-A"]);
  const { stdout } = await git(repoPath, [
    "diff",
    "--cached",
    "--name-status",
    "-z",
  ]);
  if (!stdout) return [];

  const parts = stdout.split("\0").filter((p) => p.length > 0);
  const actions: GitlabCommitAction[] = [];
  let i = 0;
  while (i < parts.length) {
    const statusRaw = parts[i]!;
    const code = statusRaw[0];
    // name-status -z: "M", "A", "D", or "R100" / "C100"
    if (code === "R" || code === "C") {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      i += 3;
      if (!oldPath || !newPath) continue;
      if (code === "R") {
        try {
          const content = await fileActionContent(repoPath, newPath);
          actions.push({
            action: "move",
            file_path: newPath,
            previous_path: oldPath,
            ...content,
          });
        } catch (err) {
          logger.warn("Skip rename content read; move without content", {
            oldPath,
            newPath,
            err: String(err),
          });
          actions.push({
            action: "move",
            file_path: newPath,
            previous_path: oldPath,
          });
        }
      } else {
        // Copy → create at new path
        const content = await fileActionContent(repoPath, newPath);
        actions.push({
          action: "create",
          file_path: newPath,
          ...content,
        });
      }
      continue;
    }

    const filePath = parts[i + 1];
    i += 2;
    if (!filePath) continue;

    if (code === "D") {
      actions.push({ action: "delete", file_path: filePath });
      continue;
    }

    if (code === "A") {
      const content = await fileActionContent(repoPath, filePath);
      actions.push({ action: "create", file_path: filePath, ...content });
      continue;
    }

    // M, T, or other → update
    const content = await fileActionContent(repoPath, filePath);
    actions.push({ action: "update", file_path: filePath, ...content });
  }

  return actions;
}

/** Soft-reset HEAD to sha, keep all later changes in the index/worktree. */
export async function softResetTo(
  repoPath: string,
  sha: string,
): Promise<void> {
  await git(repoPath, ["reset", "--soft", sha]);
}

/**
 * After remote tip moves (GitLab API commit / force-push): fetch + hard-reset
 * so local matches remote and later agent runs do not diverge.
 */
export async function syncLocalToRemoteCommit(
  repoPath: string,
  branch: string,
  sha: string,
): Promise<void> {
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  try {
    await git(repoPath, ["fetch", "origin", refspec]);
  } catch (err) {
    try {
      await git(repoPath, ["fetch", "origin", sha]);
    } catch {
      throw new Error(
        `Could not fetch GitLab commit ${sha.slice(0, 12)} for branch ${branch}: ${String(err)}`,
      );
    }
  }

  // Ensure we are on the work branch, then hard-reset to the remote SHA
  await git(repoPath, ["checkout", "-B", branch]);
  try {
    await git(repoPath, ["reset", "--hard", sha]);
  } catch {
    // Fallback: SHA may only be reachable via origin/<branch> after fetch
    await git(repoPath, ["reset", "--hard", `origin/${branch}`]);
  }
}
