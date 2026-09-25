/**
 * Token bridge — accessToken lives in memory only (anti-XSS).
 * refreshToken + identity persist to localStorage.
 */
import {
  safeGetItem,
  safeRemoveItem,
  safeSessionGetItem,
  safeSessionRemoveItem,
  safeSessionSetItem,
  safeSetItem,
} from "@/utils/safeStorage";

const PERSIST_KEY = "flow_auto_work_session";
const LAST_LOGIN_KEY = "flow_auto_work_last_login";
/** Per-tab project — survives localStorage overwrites from other tabs. */
const TAB_PROJECT_KEY = "flow_tab_project";

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

/** In-memory project for this tab (X-Flow-Project header). */
let memoryProjectId: string | null = null;

function hydrateTabProjectId(): string | null {
  const fromSession = safeSessionGetItem(TAB_PROJECT_KEY)?.trim() || null;
  if (fromSession) {
    memoryProjectId = fromSession;
    return fromSession;
  }
  const fromLocal = loadPersistedAuthRaw().projectId?.trim() || null;
  if (fromLocal) {
    memoryProjectId = fromLocal;
    safeSessionSetItem(TAB_PROJECT_KEY, fromLocal);
  }
  return fromLocal;
}

function loadPersistedAuthRaw(): PersistedAuth {
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

/**
 * Monotonic session generation — bumped on every successful token write.
 * Stale refresh/clear paths compare against the generation captured at start
 * so a newer login cannot be wiped by an older failure (TOCTOU).
 */
let authGeneration = 0;

export function getAuthGeneration(): number {
  return authGeneration;
}

export function bumpAuthGeneration(): number {
  authGeneration += 1;
  return authGeneration;
}

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
  const auth = loadPersistedAuthRaw();
  const tabProject = memoryProjectId ?? hydrateTabProjectId();
  return {
    ...auth,
    projectId: tabProject ?? auth.projectId,
  };
}

/** Set this tab's active project (memory + sessionStorage). */
export function setActiveProjectId(projectId: string | null): void {
  const id = projectId?.trim() || null;
  memoryProjectId = id;
  if (id) {
    safeSessionSetItem(TAB_PROJECT_KEY, id);
  } else {
    safeSessionRemoveItem(TAB_PROJECT_KEY);
  }
}

/** Persist identity + refresh only — never write accessToken. */
export function savePersistedAuth(partial: Partial<PersistedAuth>): void {
  const cur = loadPersistedAuthRaw();
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
  if (partial.projectId !== undefined) {
    setActiveProjectId(partial.projectId);
  }
}

export function clearPersistedAuth(): void {
  const prev = loadPersistedAuthRaw();
  if (prev.username) {
    safeSetItem(
      LAST_LOGIN_KEY,
      JSON.stringify({
        username: prev.username,
        projectId: memoryProjectId ?? prev.projectId,
      }),
    );
  }
  safeRemoveItem(PERSIST_KEY);
  memoryAccessToken = null;
  memoryAccessExpiresAt = null;
  memoryProjectId = null;
  safeSessionRemoveItem(TAB_PROJECT_KEY);
}

/**
 * Clear session only if storage still holds `expectedRefresh` (or there is no
 * refresh). Returns false when a newer login already replaced the token.
 *
 * Important: `expectedRefresh == null` must NOT wipe a present refresh token.
 * On mobile wake, localStorage can briefly fail so getRefreshToken() returns
 * null while the key still exists — clearing would false-logout the user.
 */
export function clearPersistedAuthIfRefresh(
  expectedRefresh: string | null,
): boolean {
  const cur = loadPersistedAuthRaw();
  if (expectedRefresh == null) {
    if (cur.refreshToken) return false;
    clearPersistedAuth();
    return true;
  }
  if (cur.refreshToken && cur.refreshToken !== expectedRefresh) {
    return false;
  }
  clearPersistedAuth();
  return true;
}

export function getRefreshToken(): string | null {
  return loadPersistedAuthRaw().refreshToken;
}

export function getUsername(): string | null {
  return loadPersistedAuthRaw().username;
}

export function getProjectId(): string | null {
  return memoryProjectId ?? hydrateTabProjectId();
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
  bumpAuthGeneration();
}

export { LAST_LOGIN_KEY, PERSIST_KEY };
