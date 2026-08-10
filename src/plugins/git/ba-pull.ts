import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../../logger.js";
import { buildOauthCloneUrl } from "../../workspace/clone.js";
import {
  getBaProject,
  getBaProjectGitlabToken,
  type BaProject,
} from "../../workspace/baStore.js";

const execFileAsync = promisify(execFile);

async function gitBa(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
    },
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

/**
 * Fast-forward shared BA clone to latest remote branch using project PAT.
 * Hard-resets to FETCH_HEAD so BA always answers from current remote code.
 */
export async function pullBaProjectLatest(project: BaProject): Promise<void> {
  const token = await getBaProjectGitlabToken(project.id);
  if (!token) {
    throw new Error("GitLab PAT missing — admin cần cập nhật PAT rồi clone lại");
  }
  const branch = (project.mainBranch || "main").trim() || "main";
  const url = buildOauthCloneUrl(
    project.gitlabHost,
    token,
    project.gitlabPath,
  );

  logger.info("BA project git pull starting", {
    projectId: project.id,
    branch,
    localPath: project.localPath,
  });

  try {
    await gitBa(project.localPath, ["fetch", "--prune", url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  } catch (err) {
    // Fallback: fetch ref into FETCH_HEAD
    await gitBa(project.localPath, ["fetch", url, branch]);
    await gitBa(project.localPath, ["checkout", "-B", branch, "FETCH_HEAD"]);
    logger.info("BA project git pull done (FETCH_HEAD)", {
      projectId: project.id,
      branch,
    });
    return;
  }

  await gitBa(project.localPath, [
    "checkout",
    "-B",
    branch,
    `origin/${branch}`,
  ]);

  logger.info("BA project git pull done", {
    projectId: project.id,
    branch,
  });
}

export async function pullBaProjectLatestById(projectId: string): Promise<void> {
  const project = await getBaProject(projectId);
  if (!project) throw new Error("BA project not found");
  await pullBaProjectLatest(project);
}
