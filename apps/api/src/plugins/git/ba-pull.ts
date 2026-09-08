import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../../logger.js";
import {
  buildOauthCloneUrl,
  gitHttpAuthEnvFromCloneUrl,
  stripCloneUrlCredentials,
} from "../../workspace/clone.js";
import {
  getBaProject,
  getBaProjectGitlabToken,
  type BaProject,
} from "../../workspace/baStore.js";
import { scheduleProjectGraphify } from "../../workspace/graphify.js";
import { redactGitError } from "./redact.js";

const execFileAsync = promisify(execFile);

/** Serialize fetch/checkout per BA project — shared clone is not multi-writer safe. */
const pullChainByProject = new Map<string, Promise<void>>();

async function gitBa(
  repoPath: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        ...extraEnv,
      },
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (err) {
    throw redactGitError(err);
  }
}

async function pullBaProjectLatestUnlocked(project: BaProject): Promise<void> {
  const token = await getBaProjectGitlabToken(project.id);
  if (!token) {
    throw new Error("GitLab PAT missing — admin cần cập nhật PAT rồi clone lại");
  }
  const branch = (project.mainBranch || "main").trim() || "main";
  const patUrl = buildOauthCloneUrl(
    project.gitlabHost,
    token,
    project.gitlabPath,
  );
  const url = stripCloneUrlCredentials(patUrl);
  const authEnv = gitHttpAuthEnvFromCloneUrl(patUrl);

  logger.info("BA project git pull starting", {
    projectId: project.id,
    branch,
    localPath: project.localPath,
  });

  try {
    await gitBa(
      project.localPath,
      [
        "fetch",
        "--prune",
        url,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      authEnv,
    );
  } catch {
    // Fallback: fetch ref into FETCH_HEAD
    await gitBa(project.localPath, ["fetch", url, branch], authEnv);
    await gitBa(project.localPath, ["checkout", "-B", branch, "FETCH_HEAD"]);
    logger.info("BA project git pull done (FETCH_HEAD)", {
      projectId: project.id,
      branch,
    });
    scheduleProjectGraphify(project.localPath, "ba-pull");
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
  scheduleProjectGraphify(project.localPath, "ba-pull");
}

/**
 * Fast-forward shared BA clone to latest remote branch using project PAT.
 * Hard-resets to FETCH_HEAD so BA always answers from current remote code.
 * Concurrent pulls on the same project are queued (not parallel).
 */
export async function pullBaProjectLatest(project: BaProject): Promise<void> {
  const key = project.id;
  const prev = pullChainByProject.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chain holders so waiters serialize; errors must not break the queue.
  const holder = prev.then(
    () => gate,
    () => gate,
  );
  pullChainByProject.set(key, holder);

  await prev.then(
    () => undefined,
    () => undefined,
  );
  try {
    await pullBaProjectLatestUnlocked(project);
  } finally {
    release();
    // Drop map entry only if we are still the tail waiter.
    void holder.then(() => {
      if (pullChainByProject.get(key) === holder) {
        pullChainByProject.delete(key);
      }
    });
  }
}

export async function pullBaProjectLatestById(projectId: string): Promise<void> {
  const project = await getBaProject(projectId);
  if (!project) throw new Error("BA project not found");
  await pullBaProjectLatest(project);
}
