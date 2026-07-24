/**
 * Compatibility facade — prefer `@/api/http`, `@/api/authApi`, `@/api/jobApi`,
 * and `useAuthStore` for new code.
 *
 * Tokens: accessToken is memory-only; refreshToken persists via tokenStorage.
 */
import type { AxiosRequestConfig } from "axios";
import { API } from "./endpoints";
import {
  ApiError,
  clearAuthSession,
  refreshAccessTokenRaw,
  request,
  type HttpRequestConfig,
} from "./http";
import {
  applyTokenPair,
  clearPersistedAuth,
  getAccessExpiresAt,
  getAccessToken,
  getRefreshToken,
  loadPersistedAuth,
  savePersistedAuth,
  setAccessToken,
  type PersistedAuth,
} from "./tokenStorage";

export { ApiError, API };
export { authApi } from "./authApi";
export { jobApi } from "./jobApi";
export {
  getAccessToken,
  getRefreshToken,
  loadPersistedAuth,
  clearPersistedAuth,
} from "./tokenStorage";

/** @deprecated shape kept for session store / realtime */
export type Session = {
  username: string | null;
  projectId: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessExpiresAt?: number | null;
};

export function loadSession(): Session {
  const p = loadPersistedAuth();
  return {
    username: p.username,
    projectId: p.projectId,
    accessToken: getAccessToken(),
    refreshToken: p.refreshToken,
    accessExpiresAt: getAccessExpiresAt(),
  };
}

/** Persist identity + refresh only (never accessToken). */
export function saveSession(session: Session): void {
  savePersistedAuth({
    username: session.username,
    projectId: session.projectId,
    refreshToken: session.refreshToken ?? null,
  });
  if (session.accessToken) {
    setAccessToken(
      session.accessToken,
      session.accessExpiresAt ?? getAccessExpiresAt(),
    );
  } else if (session.accessToken === null) {
    setAccessToken(null, null);
  }
}

export function clearSession(): void {
  clearAuthSession();
}

export async function applyAuthTokens(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  accessExpiresAt?: number;
  username?: string;
  projectId?: string | null;
}) {
  applyTokenPair({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    accessExpiresAt: tokens.accessExpiresAt,
    username: tokens.username,
    projectId: tokens.projectId,
  });
}

export async function refreshAccessToken(): Promise<boolean> {
  try {
    if (!getRefreshToken()) return false;
    await refreshAccessTokenRaw();
    return true;
  } catch {
    clearAuthSession();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("flow:session-expired"));
    }
    return false;
  }
}

/**
 * Drop-in replacement for the old fetch-based `api()`.
 * Uses Axios + interceptor refresh queue under the hood.
 */
export async function api<T = unknown>(
  path: string,
  opts: RequestInit & {
    session?: Session;
    skipRefresh?: boolean;
    skipAuth?: boolean;
  } = {},
): Promise<T> {
  const method = (opts.method || "GET").toUpperCase();
  let data: unknown;
  if (opts.body != null && typeof opts.body === "string" && opts.body.length) {
    try {
      data = JSON.parse(opts.body);
    } catch {
      data = opts.body;
    }
  }

  const config: HttpRequestConfig = {
    url: path,
    method: method as AxiosRequestConfig["method"],
    data: method === "GET" || method === "HEAD" ? undefined : data,
    skipRefresh: opts.skipRefresh,
    skipAuth: opts.skipAuth,
  };

  // Allow caller to temporarily override identity headers via session
  if (opts.session) {
    if (opts.session.accessToken) {
      setAccessToken(
        opts.session.accessToken,
        opts.session.accessExpiresAt ?? getAccessExpiresAt(),
      );
    }
    if (
      opts.session.username != null ||
      opts.session.projectId != null ||
      opts.session.refreshToken != null
    ) {
      const patch: Partial<PersistedAuth> = {};
      if (opts.session.username !== undefined) {
        patch.username = opts.session.username;
      }
      if (opts.session.projectId !== undefined) {
        patch.projectId = opts.session.projectId;
      }
      if (opts.session.refreshToken !== undefined) {
        patch.refreshToken = opts.session.refreshToken;
      }
      savePersistedAuth(patch);
    }
  }

  return request<T>(config);
}

export { refreshAccessTokenRaw };
