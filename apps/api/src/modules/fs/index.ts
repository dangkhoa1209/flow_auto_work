import { browseDirectory } from "../../plugins/fs/browse.js";
import { resolveRuntimeContext } from "../../workspace/resolve.js";
import { AppError } from "../../utils/AppError.js";

export async function browseLocalPath(username: string, pathRaw?: string) {
  if (!username.trim()) throw new AppError("X-Flow-User required", 401);
  try {
    return await browseDirectory(pathRaw?.trim() || undefined);
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

/** @deprecated alias */
export const browseFs = browseLocalPath;

export async function getWorkspaceContext(username: string, projectId: string) {
  if (!username.trim() || !projectId.trim()) {
    throw new AppError("X-Flow-User and X-Flow-Project required", 401);
  }
  try {
    const ctx = await resolveRuntimeContext({
      gitlabUsername: username,
      projectId,
    });
    return {
      gitlabUsername: ctx.gitlabUsername,
      projectId: ctx.projectId,
      gitlabPath: ctx.gitlabPath,
      repoPath: ctx.repoPath,
      baseBranch: ctx.baseBranch ?? null,
      workBranch: ctx.workBranch ?? null,
      hasSecrets: true,
    };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}
