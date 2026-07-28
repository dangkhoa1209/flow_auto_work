/**
 * Token bridge — same contract as Flow coding web (`web/src/api/tokenStorage.ts`).
 * accessToken in memory only; refreshToken + identity persist.
 */

const PERSIST_KEY = "qa_agents_session";
const LAST_LOGIN_KEY = "flow_auto_work_last_login";

export type PersistedAuth = {
  username: string | null;
  projectId: string | null;
  refreshToken: string | null;
  accessToken?: string | null;
  accessExpiresAt?: number | null;
};

let memoryAccessToken: string | null = null;
let memoryAccessExpiresAt: number | null = null;

export function getAccessToken() {
  return memoryAccessToken;
}

export function getAccessExpiresAt() {
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
    const raw = localStorage.getItem(PERSIST_KEY);
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
  localStorage.setItem(PERSIST_KEY, JSON.stringify(next));
}

export function clearPersistedAuth(): void {
  const prev = loadPersistedAuth();
  if (prev.username) {
    try {
      localStorage.setItem(
        LAST_LOGIN_KEY,
        JSON.stringify({
          username: prev.username,
          projectId: prev.projectId,
        }),
      );
    } catch {
      /* ignore */
    }
  }
  localStorage.removeItem(PERSIST_KEY);
  memoryAccessToken = null;
  memoryAccessExpiresAt = null;
}

export function getRefreshToken() {
  return loadPersistedAuth().refreshToken;
}

export function getUsername() {
  return loadPersistedAuth().username;
}

export function getProjectId() {
  return loadPersistedAuth().projectId;
}

export function setProjectId(projectId: string | null) {
  savePersistedAuth({ projectId });
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
    opts.accessExpiresAt || Date.now() + (opts.expiresIn || 600) * 1000;
  setAccessToken(opts.accessToken, expiresAt);
  const patch: Partial<PersistedAuth> = {
    refreshToken: opts.refreshToken,
  };
  if (opts.username !== undefined) patch.username = opts.username;
  if (opts.projectId !== undefined) patch.projectId = opts.projectId;
  savePersistedAuth(patch);
}

export { LAST_LOGIN_KEY, PERSIST_KEY };
