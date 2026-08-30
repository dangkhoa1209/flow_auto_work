import { listCursorModelsForApiKey } from "../../plugins/cursor/modelList.js";
import { verifyGitlabTokenUser } from "../../plugins/gitlab/client.js";
import {
  clearCursorApiKey,
  getHandoffPrefs,
  getUserByUsername,
  getUserSecrets,
  setHandoffPrefs,
  setUserQcRole,
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
  const raw = await getUserByUsername(user);
  if (!raw) throw new AppError("User not found — login first", 404);
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
  return { user: updated, ok: true };
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
 * Always includes `auto`. Falls back to static list if SDK list fails / no key.
 */
export async function listCursorModels(username: string) {
  const user = requireUser(username);
  const secrets = await getUserSecrets(user);
  const found = await getUserByUsername(user);
  return listCursorModelsForApiKey(
    secrets?.cursorApiKey?.trim() || "",
    found?.cursorModel,
  );
}

/** Clear Cursor API key */
export async function clearMyCursorKey(username: string) {
  const user = requireUser(username);
  try {
    const updated = await clearCursorApiKey(user);
    return { user: updated, ok: true };
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
