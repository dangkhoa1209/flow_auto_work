import {
  createBaProject,
  deleteBaProject,
  getBaProject,
  getBaProjectGitlabToken,
  getSystemSettings,
  listBaProjects,
  toPublicBaProject,
  toPublicSystemSettings,
  updateBaProject,
  updateSystemCursorSettings,
} from "../../workspace/baStore.js";
import { buildOauthCloneUrl, isGitRepo, runGitClone } from "../../workspace/clone.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../logger.js";

export async function adminListBaProjects() {
  return (await listBaProjects()).map(toPublicBaProject);
}

export async function adminCreateBaProject(body: {
  displayName?: string;
  slug?: string;
  gitlabPath?: string;
  gitlabHost?: string;
  gitlabToken?: string;
  mainBranch?: string;
  localPath?: string;
}) {
  const displayName = body.displayName?.trim();
  const gitlabPath = body.gitlabPath?.trim();
  if (!displayName || !gitlabPath) {
    throw new AppError("displayName and gitlabPath required", 400);
  }
  try {
    const project = await createBaProject({
      displayName,
      slug: body.slug,
      gitlabPath,
      gitlabHost: body.gitlabHost,
      gitlabToken: body.gitlabToken,
      mainBranch: body.mainBranch,
      localPath: body.localPath,
    });
    return { project: toPublicBaProject(project) };
  } catch (err) {
    throw new AppError(
      err instanceof Error ? err.message : String(err),
      400,
    );
  }
}

export async function adminUpdateBaProject(
  idRaw: string,
  body: {
    displayName?: string;
    gitlabPath?: string;
    gitlabHost?: string;
    gitlabToken?: string;
    mainBranch?: string;
    localPath?: string;
  },
) {
  const id = idRaw.trim();
  try {
    const project = await updateBaProject(id, body);
    return { project: toPublicBaProject(project) };
  } catch (err) {
    throw new AppError(
      err instanceof Error ? err.message : String(err),
      404,
    );
  }
}

export async function adminDeleteBaProject(idRaw: string) {
  const ok = await deleteBaProject(idRaw.trim());
  if (!ok) throw new AppError("BA project not found", 404);
  return { ok: true };
}

export async function adminCloneBaProject(
  idRaw: string,
  body: { confirm?: boolean; gitlabToken?: string },
) {
  if (!body.confirm) {
    throw new AppError(
      "Set confirm:true after UI confirmation prompt",
      400,
      "clone_confirm_required",
    );
  }
  const id = idRaw.trim();
  let project = await getBaProject(id);
  if (!project) throw new AppError("BA project not found", 404);

  if (body.gitlabToken?.trim()) {
    project = await updateBaProject(id, {
      gitlabToken: body.gitlabToken.trim(),
    });
  }

  const token = await getBaProjectGitlabToken(id);
  if (!token) {
    throw new AppError("GitLab PAT required before clone", 400);
  }

  if (await isGitRepo(project.localPath)) {
    await updateBaProject(id, { cloneStatus: "ready", cloneError: null });
    return {
      ok: true,
      alreadyCloned: true,
      project: toPublicBaProject((await getBaProject(id))!),
    };
  }

  if (project.cloneStatus === "cloning") {
    return { ok: true, cloning: true, project: toPublicBaProject(project) };
  }

  await updateBaProject(id, { cloneStatus: "cloning", cloneError: null });

  const cloneUrl = buildOauthCloneUrl(
    project.gitlabHost,
    token,
    project.gitlabPath,
  );
  const localPath = project.localPath;

  void (async () => {
    try {
      await runGitClone({ cloneUrl, localPath });
      await updateBaProject(id, { cloneStatus: "ready", cloneError: null });
      logger.info("BA project clone ready", { id, localPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateBaProject(id, { cloneStatus: "failed", cloneError: msg });
      logger.error("BA project clone failed", { id, err: msg });
    }
  })();

  return {
    ok: true,
    cloning: true,
    project: toPublicBaProject((await getBaProject(id))!),
  };
}

export async function adminGetBaCloneStatus(idRaw: string) {
  const project = await getBaProject(idRaw.trim());
  if (!project) throw new AppError("BA project not found", 404);
  const ready =
    project.cloneStatus === "ready" && (await isGitRepo(project.localPath));
  return {
    project: toPublicBaProject(project),
    ready,
    isGitRepo: await isGitRepo(project.localPath),
  };
}

export async function adminGetCursorSettings() {
  return toPublicSystemSettings(await getSystemSettings());
}

export async function adminUpdateCursorSettings(body: {
  cursorApiKey?: string | null;
  cursorModel?: string;
}) {
  const s = await updateSystemCursorSettings(body);
  return toPublicSystemSettings(s);
}
