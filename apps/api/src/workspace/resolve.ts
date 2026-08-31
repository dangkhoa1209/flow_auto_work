import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isGitRepo } from "./clone.js";
import {
  getMembership,
  getProject,
  getProjectSecrets,
  getUserByUsername,
  getUserSecrets,
} from "./store.js";
import type { RuntimeContext } from "./runtime.js";
import { AppError } from "../utils/AppError.js";
import { normalizeGitProvider } from "./types.js";

async function assertRepoPath(repoPath: string): Promise<void> {
  try {
    await access(repoPath, constants.R_OK);
  } catch {
    throw new Error(`Local repo path not readable: ${repoPath}`);
  }
}

/**
 * Build runtime context for a logged-in user + selected project.
 * Remote PAT comes from the **project**; Cursor key from the user.
 *
 * By default does **not** require a local git clone — stats/tasks/jobs list work without one.
 * Pass `requireLocalClone: true` for agent runs, terminal, and other source-dependent flows.
 */
export async function resolveRuntimeContext(opts: {
  gitlabUsername: string;
  projectId: string;
  requireLocalClone?: boolean;
}): Promise<RuntimeContext> {
  const user = await getUserByUsername(opts.gitlabUsername);
  if (!user) {
    throw new Error(`User not found: ${opts.gitlabUsername}`);
  }

  const project = await getProject(opts.projectId);
  if (!project) throw new Error(`Project not found: ${opts.projectId}`);

  const membership = await getMembership(opts.gitlabUsername, opts.projectId);
  if (!membership) {
    throw new Error(
      `User @${opts.gitlabUsername} has no access to project ${project.gitlabPath || project.projectName}`,
    );
  }

  const gitProvider = normalizeGitProvider(project.gitProvider);
  const forgeLabel = gitProvider === "github" ? "GitHub" : "GitLab";

  const projectSecrets = await getProjectSecrets(opts.projectId);
  const userSecrets = await getUserSecrets(opts.gitlabUsername, opts.projectId);
  const gitlabToken =
    projectSecrets?.gitlabToken || userSecrets?.gitlabToken || "";
  if (!gitlabToken) {
    throw new Error(
      `Missing ${forgeLabel} token on project — add PAT in Settings → Project (then clone)`,
    );
  }

  const repoPath = project.localPath || project.repoPath;
  if (!repoPath?.trim()) {
    throw new Error("Project local_path missing — fix project setup");
  }

  if (opts.requireLocalClone) {
    const hasGit = await isGitRepo(repoPath);
    if (!hasGit) {
      throw new Error(cloneNotReadyMessage(repoPath, project.cloneStatus));
    }
    await assertRepoPath(repoPath);
  }

  return {
    gitlabUsername: opts.gitlabUsername.trim().replace(/^@/, ""),
    gitlabToken,
    cursorApiKey: userSecrets?.cursorApiKey,
    cursorModel: user.cursorModel?.trim() || "auto",
    projectId: project.id,
    gitProvider,
    gitlabHost: project.gitlabHost,
    gitlabPath: project.gitlabPath,
    gitlabProjectId: project.gitlabProjectId,
    repoPath,
    baseBranch: project.mainBranch || membership.baseBranch,
    workBranch: project.workingBranch || membership.workBranch,
    verifyCommand: project.verifyCommand?.trim() || undefined,
  };
}

function cloneNotReadyMessage(
  repoPath: string,
  cloneStatus?: string,
): string {
  return `Source not cloned at ${repoPath} (cloneStatus=${cloneStatus ?? "unknown"}). Confirm clone in Settings → Project.`;
}

/** Throw when local source is required but the project clone is not ready. */
export async function requireProjectLocalClone(projectId: string): Promise<void> {
  const ready = await assertProjectCloneReady(projectId);
  if (ready.ok && ready.level !== "bad") return;
  const project = await getProject(projectId);
  const repoPath =
    ready.localPath || project?.localPath || project?.repoPath || "(unknown)";
  throw new AppError(
    cloneNotReadyMessage(repoPath, project?.cloneStatus),
    409,
    "clone_not_ready",
  );
}

/** True when local clone is ready for agent work. */
export async function assertProjectCloneReady(projectId: string): Promise<{
  ok: boolean;
  level: "good" | "partial" | "bad";
  message?: string;
  localPath?: string;
}> {
  const project = await getProject(projectId);
  if (!project) {
    return { ok: false, level: "bad", message: "Project not found" };
  }
  const localPath = project.localPath || project.repoPath;
  if (!localPath?.trim()) {
    return {
      ok: false,
      level: "bad",
      message: "local_path missing — configure project",
    };
  }
  if (!(await isGitRepo(localPath))) {
    return {
      ok: false,
      level: "bad",
      localPath,
      message: `No git repo at ${localPath} (status: ${project.cloneStatus})`,
    };
  }
  if (!project.mainBranch && !project.workingBranch) {
    return {
      ok: true,
      level: "partial",
      localPath,
      message: "Clone OK but branches not set — will detect default",
    };
  }
  return { ok: true, level: "good", localPath };
}
