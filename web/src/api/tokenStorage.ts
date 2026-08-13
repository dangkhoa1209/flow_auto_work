/**
 * Token bridge — accessToken lives in memory only (anti-XSS).
 * refreshToken + identity persist to localStorage.
 */
import { safeGetItem, safeRemoveItem, safeSetItem } from "@/utils/safeStorage";

const PERSIST_KEY = "flow_auto_work_session";
const LAST_LOGIN_KEY = "flow_auto_work_last_login";

export type PersistedAuth = {
  username: string | null;
  projectId: string | null;
  refreshToken: string | null;
  /** @deprecated never persist — kept optional for migration cleanup */
  accessToken?: string | null;
  accessExpiresAt?: number | null;
};

/** In-memory access token (cleared on reload → bootstrap refreshes). */
let memoryAccessToken: string | null = null;
let memoryAccessExpiresAt: number | null = null;

export function getAccessToken(): string | null {
  return memoryAccessToken;
}

export function getAccessExpiresAt(): number | null {
  return memoryAccessExpiresAt;
}

export function setAccessToken(
  token: string | null,
  expiresAt?: number | null,
): void {
  memoryAccessToken = token;
  memoryAccessExpiresAt =
    expiresAt === undefined ? memoryAccessExpiresAt : expiresAt;
}

export function loadPersistedAuth(): PersistedAuth {
  try {
    const raw = safeGetItem(PERSIST_KEY);
    if (!raw) {
      return { username: null, projectId: null, refreshToken: null };
    }
    const parsed = JSON.parse(raw) as PersistedAuth;
    return {
      username: parsed.username || null,
      projectId: parsed.projectId || null,
      refreshToken: parsed.refreshToken || null,
      accessExpiresAt: parsed.accessExpiresAt ?? null,
    };
  } catch {
    return { username: null, projectId: null, refreshToken: null };
  }
}

/** Persist identity + refresh only — never write accessToken. */
export function savePersistedAuth(partial: Partial<PersistedAuth>): void {
  const cur = loadPersistedAuth();
  const next: PersistedAuth = {
    username:
      partial.username !== undefined ? partial.username : cur.username,
    projectId:
      partial.projectId !== undefined ? partial.projectId : cur.projectId,
    refreshToken:
      partial.refreshToken !== undefined
        ? partial.refreshToken
        : cur.refreshToken,
  };
  safeSetItem(PERSIST_KEY, JSON.stringify(next));
}

export function clearPersistedAuth(): void {
  const prev = loadPersistedAuth();
  if (prev.username) {
    safeSetItem(
      LAST_LOGIN_KEY,
      JSON.stringify({
        username: prev.username,
        projectId: prev.projectId,
      }),
    );
  }
  safeRemoveItem(PERSIST_KEY);
  memoryAccessToken = null;
  memoryAccessExpiresAt = null;
}

export function getRefreshToken(): string | null {
  return loadPersistedAuth().refreshToken;
}

export function getUsername(): string | null {
  return loadPersistedAuth().username;
}

export function getProjectId(): string | null {
  return loadPersistedAuth().projectId;
}

export function applyTokenPair(opts: {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  accessExpiresAt?: number;
  username?: string | null;
  projectId?: string | null;
}): void {
  const expiresAt =
    opts.accessExpiresAt ||
    Date.now() + (opts.expiresIn || 2 * 60 * 60) * 1000;
  setAccessToken(opts.accessToken, expiresAt);
  const patch: Partial<PersistedAuth> = {
    refreshToken: opts.refreshToken,
  };
  if (opts.username !== undefined) patch.username = opts.username;
  if (opts.projectId !== undefined) patch.projectId = opts.projectId;
  savePersistedAuth(patch);
}

export { LAST_LOGIN_KEY, PERSIST_KEY };
