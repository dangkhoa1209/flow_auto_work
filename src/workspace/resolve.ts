import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { getConfig } from "../config.js";
import {
  getMembership,
  getProject,
  getUserByUsername,
  getUserSecrets,
} from "./store.js";
import type { RuntimeContext } from "./runtime.js";

async function assertRepoPath(repoPath: string): Promise<void> {
  try {
    await access(repoPath, constants.R_OK);
  } catch {
    throw new Error(`Local repo path not readable: ${repoPath}`);
  }
}

/**
 * Build runtime context for a logged-in user + selected project.
 * Decrypts tokens in memory only.
 */
export async function resolveRuntimeContext(opts: {
  gitlabUsername: string;
  projectId: string;
}): Promise<RuntimeContext> {
  const secrets = await getUserSecrets(opts.gitlabUsername);
  if (!secrets?.gitlabToken) {
    throw new Error(
      "Missing encrypted GitLab token — login lại với GitLab PAT",
    );
  }
  const project = await getProject(opts.projectId);
  if (!project) throw new Error(`Project not found: ${opts.projectId}`);
  const membership = await getMembership(opts.gitlabUsername, opts.projectId);
  if (!membership) {
    throw new Error(
      `User @${opts.gitlabUsername} has not joined project ${project.gitlabPath}`,
    );
  }
  await assertRepoPath(project.repoPath);
  const user = await getUserByUsername(opts.gitlabUsername);
  return {
    gitlabUsername: opts.gitlabUsername.trim().replace(/^@/, ""),
    gitlabToken: secrets.gitlabToken,
    cursorApiKey: secrets.cursorApiKey,
    cursorModel: user?.cursorModel?.trim() || "auto",
    projectId: project.id,
    gitlabPath: project.gitlabPath,
    gitlabProjectId: project.gitlabProjectId,
    repoPath: project.repoPath,
    baseBranch: membership.baseBranch,
    workBranch: membership.workBranch,
  };
}

/** Fallback for scripts / legacy single-user .env (optional). */
export function legacyRuntimeFromEnv(): RuntimeContext | null {
  const c = getConfig();
  if (
    !c.GITLAB_TOKEN ||
    !c.AIHR_REPO_PATH ||
    !c.ALLOWED_PROJECT_PATH ||
    !c.GITLAB_ASSIGNEE_USERNAME
  ) {
    return null;
  }
  return {
    gitlabUsername: c.GITLAB_ASSIGNEE_USERNAME,
    gitlabToken: c.GITLAB_TOKEN,
    cursorApiKey: c.CURSOR_API_KEY,
    cursorModel: "auto",
    projectId: "legacy",
    gitlabPath: c.ALLOWED_PROJECT_PATH,
    repoPath: c.AIHR_REPO_PATH,
  };
}
