import {
  createBaProject,
  deleteBaProject,
  getBaProject,
  getBaProjectGitlabToken,
  getSystemSettings,
  getTaskTypeLabelMapping,
  listBaProjects,
  resolveBaProjectDbForTest,
  resolveBaCreateDataDbForTest,
  toPublicBaProject,
  toPublicSystemSettings,
  updateBaProject,
  updateSystemBaFeatures,
  updateSystemCursorSettings,
  updateSystemTaskTypeLabels,
  resolveSystemCursorApiKeyForPat,
  getSystemCursorSettingsPublic,
  addSystemCursorPat,
  updateSystemCursorPat,
  setActiveSystemCursorPat,
  deleteSystemCursorPat,
  isBaDevMode,
  normalizeBaFeatures,
  type BaCreateDataConfigPatch,
  type BaDbConnectionPatch,
  type BaDbDialect,
  type BaFeatureState,
} from "../../workspace/baStore.js";
import { buildOauthCloneUrl, isGitRepo, runGitClone } from "../../workspace/clone.js";
import { scheduleProjectGraphify } from "../../workspace/graphify.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../logger.js";
import { testBaDbConnection } from "../../plugins/baDb/query.js";
import { withBaDbResolvedConnection } from "../../plugins/baDb/withTunnel.js";
import { listCursorModelsForApiKey } from "../../plugins/cursor/modelList.js";
import { assertSafeCreateDataTarget } from "../createData/executor.js";

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

function parseDbPatch(raw: unknown): BaDbConnectionPatch | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return { clear: true };
  if (typeof raw !== "object") {
    throw new AppError("db must be an object", 400);
  }
  const b = raw as Record<string, unknown>;
  if (b.clear === true) return { clear: true };

  const patch: BaDbConnectionPatch = {};
  if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
  if (b.dialect !== undefined) {
    patch.dialect = String(b.dialect) as BaDbDialect;
  }
  if (b.host !== undefined) patch.host = String(b.host);
  if (b.port !== undefined) {
    const n = Number(b.port);
    if (!Number.isFinite(n) || n <= 0) {
      throw new AppError("db.port invalid", 400);
    }
    patch.port = Math.floor(n);
  }
  if (b.database !== undefined) patch.database = String(b.database);
  if (b.username !== undefined) patch.username = String(b.username);
  if (b.authSource !== undefined) patch.authSource = String(b.authSource);
  if (b.password !== undefined && String(b.password).length > 0) {
    patch.password = String(b.password);
  }
  if (b.ssl !== undefined) patch.ssl = Boolean(b.ssl);
  if (b.ssh !== undefined) {
    if (b.ssh === null) {
      patch.ssh = { clear: true };
    } else if (typeof b.ssh === "object") {
      const s = b.ssh as Record<string, unknown>;
      if (s.clear === true) {
        patch.ssh = { clear: true };
      } else {
        const ssh: NonNullable<BaDbConnectionPatch["ssh"]> = {};
        if (s.enabled !== undefined) ssh.enabled = Boolean(s.enabled);
        if (s.sshHost !== undefined) ssh.sshHost = String(s.sshHost);
        if (s.sshPort !== undefined) {
          const n = Number(s.sshPort);
          if (!Number.isFinite(n) || n <= 0) {
            throw new AppError("db.ssh.sshPort invalid", 400);
          }
          ssh.sshPort = Math.floor(n);
        }
        if (s.sshUsername !== undefined) {
          ssh.sshUsername = String(s.sshUsername);
        }
        if (s.sshPassword !== undefined && String(s.sshPassword).length > 0) {
          ssh.sshPassword = String(s.sshPassword);
        }
        if (
          s.sshPrivateKey !== undefined &&
          String(s.sshPrivateKey).length > 0
        ) {
          ssh.sshPrivateKey = String(s.sshPrivateKey);
        }
        if (s.clearSshPassword === true) ssh.clearSshPassword = true;
        if (s.clearSshPrivateKey === true) ssh.clearSshPrivateKey = true;
        if (s.tunnelLocalPort !== undefined) {
          const n = Number(s.tunnelLocalPort);
          if (!Number.isFinite(n) || n <= 0) {
            throw new AppError("db.ssh.tunnelLocalPort invalid", 400);
          }
          ssh.tunnelLocalPort = Math.floor(n);
        }
        patch.ssh = ssh;
      }
    } else {
      throw new AppError("db.ssh must be an object", 400);
    }
  }
  return patch;
}

function parseCreateDataPatch(
  raw: unknown,
): BaCreateDataConfigPatch | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return { clear: true };
  if (typeof raw !== "object") {
    throw new AppError("createData must be an object", 400);
  }
  const b = raw as Record<string, unknown>;
  if (b.clear === true) return { clear: true };
  const patch: BaCreateDataConfigPatch = {};
  if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
  // HTTP API targets retired — ignore incoming targets
  if (b.targets !== undefined) {
    patch.targets = [];
  }
  if (b.notes !== undefined) {
    patch.notes =
      b.notes == null ? null : String(b.notes).trim() || null;
  }
  if (b.db !== undefined) {
    const dbPatch = parseDbPatch(b.db);
    if (dbPatch !== undefined) patch.db = dbPatch;
  }
  return patch;
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
    db?: unknown;
    createData?: unknown;
  },
) {
  const id = idRaw.trim();
  try {
    const db = parseDbPatch(body.db);
    const createData = parseCreateDataPatch(body.createData);
    const project = await updateBaProject(id, {
      displayName: body.displayName,
      gitlabPath: body.gitlabPath,
      gitlabHost: body.gitlabHost,
      gitlabToken: body.gitlabToken,
      mainBranch: body.mainBranch,
      localPath: body.localPath,
      ...(db !== undefined ? { db } : {}),
      ...(createData !== undefined ? { createData } : {}),
    });
    return { project: toPublicBaProject(project) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const notFound = /not found/i.test(msg);
    throw new AppError(msg, notFound ? 404 : 400);
  }
}

export async function adminTestBaProjectDb(idRaw: string) {
  const id = idRaw.trim();
  const cfg = await resolveBaProjectDbForTest(id);
  if (!cfg) {
    throw new AppError(
      "DB chưa được cấu hình — lưu host/database (và password nếu cần) trước",
      400,
      "ba_db_not_configured",
    );
  }
  try {
    const result = await testBaDbConnection(cfg);
    return {
      ok: true as const,
      dialect: result.dialect,
      elapsedMs: result.elapsedMs,
    };
  } catch (err) {
    throw new AppError(
      err instanceof Error ? err.message : String(err),
      400,
      "ba_db_test_failed",
    );
  }
}

export async function adminTestBaCreateDataDb(idRaw: string) {
  const id = idRaw.trim();
  const cfg = await resolveBaCreateDataDbForTest(id);
  if (!cfg) {
    throw new AppError(
      "Create Data DB chưa cấu hình — lưu host/database (và password nếu cần) trước",
      400,
      "create_data_db_not_configured",
    );
  }
  try {
    assertSafeCreateDataTarget(cfg);
    const result = await withBaDbResolvedConnection(cfg, (connectCfg) =>
      testBaDbConnection(connectCfg),
    );
    return {
      ok: true as const,
      dialect: result.dialect,
      elapsedMs: result.elapsedMs,
      viaSsh: Boolean(cfg.ssh?.enabled && cfg.ssh.sshHost),
    };
  } catch (err) {
    throw new AppError(
      err instanceof Error ? err.message : String(err),
      400,
      "create_data_db_test_failed",
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
    scheduleProjectGraphify(project.localPath, "ba-already-cloned");
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
      scheduleProjectGraphify(localPath, "ba-clone");
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
  return getSystemCursorSettingsPublic();
}

/** Cursor model list for shared BA key (same shape as /api/me/cursor-models). */
export async function adminListCursorModels(patId?: string) {
  const s = await getSystemSettings();
  let apiKey = "";
  try {
    apiKey = await resolveSystemCursorApiKeyForPat(patId);
  } catch {
    /* no key — fallback list */
  }
  return listCursorModelsForApiKey(apiKey, s.cursorModel);
}

export async function adminUpdateCursorSettings(body: {
  cursorApiKey?: string | null;
  cursorModel?: string;
}) {
  const s = await updateSystemCursorSettings(body);
  return toPublicSystemSettings(s);
}

export async function adminAddCursorPat(body: {
  label?: string;
  apiKey?: string;
}) {
  const apiKey = body.apiKey?.trim();
  if (!apiKey) throw new AppError("apiKey required", 400);
  try {
    const s = await addSystemCursorPat({
      label: body.label,
      apiKey,
    });
    return toPublicSystemSettings(s);
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

export async function adminUpdateCursorPat(
  patId: string,
  body: { label?: string; apiKey?: string },
) {
  try {
    const s = await updateSystemCursorPat(patId, body);
    return toPublicSystemSettings(s);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, /not found/i.test(msg) ? 404 : 400);
  }
}

export async function adminSetActiveCursorPat(patId: string) {
  try {
    const s = await setActiveSystemCursorPat(patId);
    return toPublicSystemSettings(s);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, /not found/i.test(msg) ? 404 : 400);
  }
}

export async function adminDeleteCursorPat(patId: string) {
  try {
    const s = await deleteSystemCursorPat(patId);
    return toPublicSystemSettings(s);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, /not found/i.test(msg) ? 404 : 400);
  }
}

export async function adminGetTaskTypeLabels() {
  const { labels, updatedAt } = await getTaskTypeLabelMapping();
  return { taskTypeLabels: labels, updatedAt };
}

export async function adminUpdateTaskTypeLabels(body: {
  bug?: string[];
  feature?: string[];
  refactor?: string[];
  chore?: string[];
}) {
  return updateSystemTaskTypeLabels(body);
}

const BA_FEATURE_STATES = new Set(["hide", "lab", "production"]);

export async function adminGetBaFeatures() {
  const s = await getSystemSettings();
  return {
    ...normalizeBaFeatures(s.baFeatures),
    devMode: isBaDevMode(),
    updatedAt: s.baFeaturesUpdatedAt ?? null,
  };
}

export async function adminUpdateBaFeatures(body: {
  createIssue?: string;
  workflow?: string;
  tasks?: string;
  syncDatabase?: string;
  createData?: string;
  workflowTabLabel?: string;
}) {
  const patch: Partial<
    Record<
      "createIssue" | "workflow" | "tasks" | "syncDatabase" | "createData",
      BaFeatureState
    >
  > & {
    workflowTabLabel?: string;
  } = {};
  for (const key of [
    "createIssue",
    "workflow",
    "tasks",
    "syncDatabase",
    "createData",
  ] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (!BA_FEATURE_STATES.has(value)) {
      throw new AppError(
        `${key} phải là hide | lab | production`,
        400,
      );
    }
    patch[key] = value as BaFeatureState;
  }
  if (body.workflowTabLabel !== undefined) {
    patch.workflowTabLabel = String(body.workflowTabLabel);
  }
  const settings = await updateSystemBaFeatures(patch);
  return {
    ...settings.baFeatures,
    devMode: isBaDevMode(),
    updatedAt: settings.baFeaturesUpdatedAt,
  };
}

export {
  adminListUsers,
  adminGetUser,
  adminCreateUserHandler,
  adminUpdateUserHandler,
  adminDisableUser,
  adminEnableUser,
  adminDeleteUser,
  adminResetPasswordHandler,
} from "./users.js";

export { adminGetCursorUsage } from "./cursorUsage.js";
