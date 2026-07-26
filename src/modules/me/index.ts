import { Cursor } from "@cursor/sdk";
import { verifyGitlabTokenUser } from "../../plugins/gitlab/client.js";
import {
  clearCursorApiKey,
  getUserByUsername,
  getUserSecrets,
  updateUserPreferences,
  upsertUserLogin,
} from "../../workspace/store.js";
import { toPublicUser } from "../../workspace/types.js";
import { AppError } from "../../utils/AppError.js";
import { listPublicMemberships } from "../project/index.js";

const FALLBACK_MODELS = [
  { id: "auto", displayName: "Auto (server picks)" },
  { id: "composer-2.5", displayName: "Composer 2.5" },
];

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
      "Provide cursorApiKey and/or cursorModel (GitLab PAT → project settings)",
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

/**
 * List Cursor models for the logged-in user's API key.
 * Always includes `auto`. Falls back to static list if SDK list fails / no key.
 */
export async function listCursorModels(username: string) {
  const user = requireUser(username);
  const secrets = await getUserSecrets(user);
  const apiKey = secrets?.cursorApiKey?.trim() || "";
  if (!apiKey) {
    return {
      models: FALLBACK_MODELS,
      source: "fallback",
      selected: (await getUserByUsername(user))?.cursorModel || "auto",
    };
  }
  try {
    const listed = await Cursor.models.list({ apiKey });
    const raw = Array.isArray(listed)
      ? listed
      : Array.isArray((listed as { models?: unknown }).models)
        ? (listed as { models: unknown[] }).models
        : [];
    const models: { id: string; displayName: string }[] = [
      { id: "auto", displayName: "Auto (server picks)" },
    ];
    const seen = new Set(["auto"]);
    for (const item of raw) {
      const m = item as { id?: string; displayName?: string; name?: string };
      const id = (m.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, displayName: m.displayName || m.name || id });
    }
    const found = await getUserByUsername(user);
    return {
      models,
      source: "cursor",
      selected: found?.cursorModel?.trim() || "auto",
    };
  } catch (err) {
    const found = await getUserByUsername(user);
    return {
      models: FALLBACK_MODELS,
      source: "fallback",
      selected: found?.cursorModel?.trim() || "auto",
      warning: err instanceof Error ? err.message : String(err),
    };
  }
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
