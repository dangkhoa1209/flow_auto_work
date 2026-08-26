import { getConfig } from "../../config.js";
import { verifyGitlabTokenUser } from "../../plugins/gitlab/client.js";
import { verifyPassword } from "../../auth/password.js";
import {
  consumeRefreshSession,
  revokeAllRefreshSessions,
  revokeRefreshSession,
  saveRefreshSession,
} from "../../auth/sessions.js";
import {
  issueAccessToken,
  newTokenPair,
  verifyRefreshToken,
  REFRESH_TTL_SEC,
} from "../../auth/tokens.js";
import {
  AUTH_USERNAME_HINT,
  isValidAuthUsername,
  normalizeAuthUsername,
} from "../../auth/username.js";
import {
  createOrUpdateUserPassword,
  getUserByUsername,
  upsertUserLogin,
} from "../../workspace/store.js";
import { isRegisterableRole, toPublicUser } from "../../workspace/types.js";
import { AppError } from "../../utils/AppError.js";
import { listPublicMemberships } from "../project/index.js";

/** Issue an access + refresh pair and persist the refresh session. */
export async function issueAuthTokens(username: string) {
  const pair = newTokenPair(username);
  await saveRefreshSession({
    jti: pair.refresh.jti,
    username,
    rawToken: pair.refresh.token,
    expiresAt: pair.refresh.expiresAt,
  });
  return {
    accessToken: pair.access.token,
    refreshToken: pair.refresh.token,
    expiresIn: pair.access.expiresIn,
    accessExpiresAt: pair.access.expiresAt,
    refreshExpiresIn: REFRESH_TTL_SEC,
    tokenType: "Bearer" as const,
  };
}

/** Public hints for the login UI (no secrets). */
export function getAuthBootstrap() {
  const config = getConfig();
  const gitlabBaseUrl = config.GITLAB_BASE_URL.replace(/\/$/, "");
  return {
    gitlabBaseUrl,
    gitlabPatUrl: `${gitlabBaseUrl}/-/user_settings/personal_access_tokens`,
    cursorApiKeyUrl: "https://cursor.com/dashboard?tab=integrations",
    defaultCursorModel: "auto",
    authMode: "password",
    bypassEnabled: Boolean(config.AUTH_BYPASS_PASSWORD?.trim()),
  };
}

/** Resolve username from a pasted GitLab PAT (not stored). */
export async function resolveTokenUser(body: { gitlabToken?: string }) {
  const token = body.gitlabToken?.trim();
  if (!token) throw new AppError("gitlabToken required", 400);
  try {
    const profile = await verifyGitlabTokenUser(token);
    return {
      username: profile.username,
      name: profile.name ?? null,
      id: profile.id,
    };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

export type RegisterBody = {
  username?: string;
  password?: string;
  displayName?: string;
  /** Platform role: dev | qc | pd | ba | devops */
  role?: string;
};

/** Register new username + password, then issue tokens (same shape as login). */
export async function registerUser(body: RegisterBody) {
  const username = normalizeAuthUsername(body.username || "");
  const password = body.password ?? "";
  const displayName = body.displayName?.trim();
  const roleRaw = (body.role || "dev").trim().toLowerCase();

  if (!username) {
    throw new AppError("username required", 400);
  }
  if (!isValidAuthUsername(username)) {
    throw new AppError(AUTH_USERNAME_HINT, 400);
  }
  if (password.length < 6) {
    throw new AppError("Password must be at least 6 characters", 400);
  }
  if (!isRegisterableRole(roleRaw)) {
    throw new AppError(
      "role must be one of: dev, qc, pd, ba, devops",
      400,
      "invalid_role",
    );
  }

  const existing = await getUserByUsername(username);
  if (existing) {
    throw new AppError("Username already exists", 409);
  }

  const user = await createOrUpdateUserPassword({
    username,
    password,
    displayName: displayName || username,
    roles: [roleRaw],
  });
  const memberships = await listPublicMemberships(username);
  const tokens = await issueAuthTokens(username);
  return {
    user,
    memberships,
    activeProjectId: memberships[0]?.projectId ?? null,
    ...tokens,
  };
}

export type LoginBody = {
  username?: string;
  password?: string;
  gitlabUsername?: string;
  /** Legacy fields ignored for auth; use project settings for PAT */
  gitlabToken?: string;
  cursorApiKey?: string;
  displayName?: string;
};

/**
 * Login with username + password.
 * If AUTH_BYPASS_PASSWORD is set and matches, skip passwordHash check.
 */
export async function loginUser(body: LoginBody) {
  const username = normalizeAuthUsername(
    body.username || body.gitlabUsername || "",
  );
  const password = body.password ?? "";
  if (!username) {
    throw new AppError("username required", 400);
  }
  if (!password) {
    throw new AppError("password required", 400);
  }

  const config = getConfig();
  const bypass = config.AUTH_BYPASS_PASSWORD?.trim();
  const existing = await getUserByUsername(username);
  if (!existing) {
    throw new AppError(
      "User not found. Registration is disabled — use a seeded account or ask an admin to create a user.",
      401,
    );
  }

  const bypassOk = Boolean(bypass && password === bypass);
  if (!bypassOk) {
    if (!existing.passwordHash) {
      throw new AppError(
        "This account has no password (legacy GitLab login). Use user khoadev or ask an admin to set a password.",
        401,
      );
    }
    const ok = await verifyPassword(password, existing.passwordHash);
    if (!ok) throw new AppError("Invalid username or password", 401);
  }

  if (body.cursorApiKey?.trim()) {
    await upsertUserLogin({
      gitlabUsername: username,
      cursorApiKey: body.cursorApiKey,
      displayName: body.displayName,
    });
  }

  const user = toPublicUser((await getUserByUsername(username)) || existing);
  const memberships = await listPublicMemberships(username);
  const tokens = await issueAuthTokens(username);
  const active =
    memberships.find(
      (m) => (m.project as { isActive?: boolean } | null)?.isActive,
    )?.projectId ||
    memberships[0]?.projectId ||
    null;
  return {
    user,
    memberships,
    activeProjectId: active,
    bypassUsed: bypassOk,
    ...tokens,
  };
}

/** Exchange refresh token → new access (refresh token is reused — no rotate race). */
export async function refreshAuthTokens(body: { refreshToken?: string }) {
  const raw = body.refreshToken?.trim();
  if (!raw) throw new AppError("refreshToken required", 400);
  try {
    const claims = verifyRefreshToken(raw);
    const ok = await consumeRefreshSession({
      jti: claims.jti,
      username: claims.sub,
      rawToken: raw,
    });
    if (!ok) {
      throw new AppError(
        "Session expired or invalid — please log in again",
        401,
        "SESSION_EXPIRED",
      );
    }
    const user = await getUserByUsername(claims.sub);
    if (!user) {
      await revokeRefreshSession(claims.jti);
      throw new AppError("User not found", 401, "SESSION_EXPIRED");
    }
    // Reuse the same refresh session so concurrent SSE + API refresh cannot
    // invalidate each other (rotation races were logging users out).
    const access = issueAccessToken(claims.sub);
    const refreshLeftSec = Math.max(
      0,
      claims.exp - Math.floor(Date.now() / 1000),
    );
    return {
      user: toPublicUser(user),
      accessToken: access.token,
      refreshToken: raw,
      expiresIn: access.expiresIn,
      accessExpiresAt: access.expiresAt,
      refreshExpiresIn: refreshLeftSec,
      tokenType: "Bearer" as const,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      err instanceof Error ? err.message : "Invalid refresh token",
      401,
      "SESSION_EXPIRED",
    );
  }
}

/** Revoke refresh session(s). */
export async function logoutUser(
  username: string,
  body: { refreshToken?: string; all?: boolean },
) {
  if (body.all && username) {
    await revokeAllRefreshSessions(username);
    return { ok: true, revoked: "all" };
  }
  const raw = body.refreshToken?.trim();
  if (raw) {
    try {
      const claims = verifyRefreshToken(raw);
      await revokeRefreshSession(claims.jti);
    } catch {
      /* already invalid */
    }
  }
  return { ok: true };
}
