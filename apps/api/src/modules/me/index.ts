import { listCursorModelsForApiKey } from "../../plugins/cursor/modelList.js";
import { decryptSecret } from "../../plugins/crypto/secrets.js";
import { verifyGitlabTokenUser } from "../../plugins/gitlab/client.js";
import {
  changeUserPassword,
  clearCursorApiKey,
  createCursorPat,
  deleteCursorPat,
  getActiveCursorApiKey,
  getHandoffPrefs,
  getUserByUsername,
  getUserSecrets,
  listCursorPats,
  migrateLegacyCursorKeyIfNeeded,
  normalizeUserCursorState,
  setActiveCursorPat,
  setHandoffPrefs,
  setUserFigmaToken,
  setUserQcRole,
  updateCursorPat,
  updateUserPreferences,
  upsertUserLogin,
} from "../../workspace/store.js";
import type { HandoffPrefs } from "../../workspace/types.js";
import { toPublicUser } from "../../workspace/types.js";
import { AppError } from "../../utils/AppError.js";
import { listPublicMemberships } from "../project/index.js";
import { getRuntimeContext } from "../../workspace/runtime.js";

function requireUser(username: string): string {
  const user = username.trim();
  if (!user) throw new AppError("X-Flow-User required", 401);
  return user;
}

export async function getMe(username: string) {
  const user = requireUser(username);
  let raw = await getUserByUsername(user);
  if (!raw) throw new AppError("User not found — login first", 404);
  raw = await normalizeUserCursorState(raw);
  const memberships = await listPublicMemberships(user);
  return { user: toPublicUser(raw), memberships };
}

export type UpdateSecretsBody = {
  gitlabToken?: string;
  cursorApiKey?: string;
  cursorModel?: string;
};

/** Update secrets only (encrypted). Never echoes tokens back. */
export async function updateMySecrets(
  username: string,
  body: UpdateSecretsBody,
) {
  const user = requireUser(username);
  if (
    !body.gitlabToken?.trim() &&
    !body.cursorApiKey?.trim() &&
    body.cursorModel === undefined
  ) {
    throw new AppError(
      "Provide gitlabToken, cursorApiKey and/or cursorModel",
      400,
    );
  }
  // GitLab PAT on user is legacy; prefer project token. Still allow optional store.
  if (body.gitlabToken?.trim()) {
    try {
      await verifyGitlabTokenUser(body.gitlabToken.trim());
    } catch (err) {
      throw new AppError(err instanceof Error ? err.message : String(err), 400);
    }
  }
  const updated = await upsertUserLogin({
    gitlabUsername: user,
    gitlabToken: body.gitlabToken,
    cursorApiKey: body.cursorApiKey,
    cursorModel: body.cursorModel,
  });
  const raw = await getUserByUsername(user);
  const normalized = raw ? await normalizeUserCursorState(raw) : null;
  return { user: normalized ? toPublicUser(normalized) : updated, ok: true };
}

/** Preferences (non-secret): Cursor model, etc. */
export async function updateMyPreferences(
  username: string,
  body: { cursorModel?: string },
) {
  const user = requireUser(username);
  if (body.cursorModel === undefined) {
    throw new AppError("cursorModel required", 400);
  }
  try {
    const updated = await updateUserPreferences({
      gitlabUsername: user,
      cursorModel: body.cursorModel,
    });
    return { user: updated, ok: true };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 404);
  }
}

/** Toggle “I am QC” capability for the current user. */
export async function setMyQcRole(username: string, enabled: boolean) {
  const user = requireUser(username);
  try {
    const updated = await setUserQcRole({ username: user, enabled });
    return { user: updated, ok: true, isQc: enabled };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 404);
  }
}

/**
 * List Cursor models for the logged-in user's API key.
 * Optional patId — preview models for a specific PAT (defaults to active).
 */
export async function listCursorModels(
  username: string,
  patId?: string,
) {
  const user = requireUser(username);
  let apiKey = "";
  if (patId?.trim()) {
    const found = await getUserByUsername(user);
    const migrated = found
      ? await migrateLegacyCursorKeyIfNeeded(found)
      : null;
    const pat = migrated?.cursorPats?.find((p) => p.id === patId.trim());
    if (pat?.keyEnc) {
      apiKey = decryptSecret(pat.keyEnc);
    }
  } else {
    apiKey = (await getActiveCursorApiKey(user))?.trim() || "";
  }
  const found = await getUserByUsername(user);
  return listCursorModelsForApiKey(apiKey, found?.cursorModel);
}

export async function getMyCursorPats(username: string) {
  const user = requireUser(username);
  return { user: await listCursorPats(user), ok: true };
}

export async function addMyCursorPat(
  username: string,
  body: { label?: string; apiKey?: string },
) {
  const user = requireUser(username);
  if (!body.apiKey?.trim()) {
    throw new AppError("apiKey required", 400);
  }
  const updated = await createCursorPat(user, {
    label: body.label,
    apiKey: body.apiKey,
  });
  return { user: updated, ok: true };
}

export async function patchMyCursorPat(
  username: string,
  patId: string,
  body: { label?: string; apiKey?: string },
) {
  const user = requireUser(username);
  if (body.label === undefined && !body.apiKey?.trim()) {
    throw new AppError("label or apiKey required", 400);
  }
  try {
    const updated = await updateCursorPat(user, patId, body);
    return { user: updated, ok: true };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 404);
  }
}

export async function activateMyCursorPat(username: string, patId: string) {
  const user = requireUser(username);
  try {
    const updated = await setActiveCursorPat(user, patId);
    return { user: updated, ok: true };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 404);
  }
}

export async function removeMyCursorPat(username: string, patId: string) {
  const user = requireUser(username);
  try {
    const updated = await deleteCursorPat(user, patId);
    return { user: updated, ok: true };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 404);
  }
}

/** Clear Cursor API key */
export async function clearMyCursorKey(username: string) {
  const user = requireUser(username);
  try {
    const updated = await clearCursorApiKey(user);
    const raw = await getUserByUsername(user);
    const normalized = raw ? await normalizeUserCursorState(raw) : null;
    return {
      user: normalized ? toPublicUser(normalized) : updated,
      ok: true,
    };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 404);
  }
}

/** Labels & handoff prefs for the active (or given) project. */
export async function getMyHandoffPrefs(
  username: string,
  projectId?: string,
) {
  const user = requireUser(username);
  const pid =
    projectId?.trim() || getRuntimeContext()?.projectId?.trim() || "";
  if (!pid) throw new AppError("projectId required — select a project", 400);
  const prefs = await getHandoffPrefs(user, pid);
  return { projectId: pid, prefs };
}

export async function updateMyHandoffPrefs(
  username: string,
  body: { projectId?: string; prefs?: HandoffPrefs },
) {
  const user = requireUser(username);
  const pid =
    body.projectId?.trim() || getRuntimeContext()?.projectId?.trim() || "";
  if (!pid) throw new AppError("projectId required — select a project", 400);
  if (!body.prefs || typeof body.prefs !== "object") {
    throw new AppError("prefs required", 400);
  }
  try {
    const prefs = await setHandoffPrefs({
      gitlabUsername: user,
      projectId: pid,
      prefs: body.prefs,
    });
    return { ok: true, projectId: pid, prefs };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 404);
  }
}

/** User-level integrations (Figma PAT, shared across projects). */
export async function updateMyIntegrations(
  username: string,
  body: { figmaToken?: string | null },
) {
  const user = requireUser(username);
  if (!Object.prototype.hasOwnProperty.call(body, "figmaToken")) {
    throw new AppError("figmaToken required", 400);
  }
  const token =
    body.figmaToken === null || body.figmaToken === ""
      ? null
      : String(body.figmaToken).trim() || null;
  const updated = await setUserFigmaToken(user, token);
  return { user: updated, ok: true };
}

/** Change login password for the current user. */
export async function changeMyPassword(
  username: string,
  body: { currentPassword?: string; newPassword?: string },
) {
  const user = requireUser(username);
  const newPassword = body.newPassword?.trim() ?? "";
  if (!newPassword) throw new AppError("newPassword required", 400);
  try {
    const updated = await changeUserPassword({
      username: user,
      currentPassword: body.currentPassword,
      newPassword,
    });
    return { user: updated, ok: true };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}
