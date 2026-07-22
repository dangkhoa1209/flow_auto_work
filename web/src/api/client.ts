const SESSION_KEY = "flow_auto_work_session";

export type Session = {
  username: string | null;
  projectId: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessExpiresAt?: number | null;
};

export function loadSession(): Session {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return emptySession();
    const parsed = JSON.parse(raw) as Session;
    return {
      username: parsed.username || null,
      projectId: parsed.projectId || null,
      accessToken: parsed.accessToken || null,
      refreshToken: parsed.refreshToken || null,
      accessExpiresAt: parsed.accessExpiresAt || null,
    };
  } catch {
    return emptySession();
  }
}

function emptySession(): Session {
  return {
    username: null,
    projectId: null,
    accessToken: null,
    refreshToken: null,
    accessExpiresAt: null,
  };
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  accessExpiresAt?: number;
};

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const session = loadSession();
    if (!session.refreshToken) return false;
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      const data = (await res.json().catch(() => ({}))) as AuthTokens & {
        error?: string;
        user?: { gitlabUsername?: string };
      };
      if (!res.ok) return false;
      const next: Session = {
        ...session,
        username:
          data.user?.gitlabUsername || session.username,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || session.refreshToken,
        accessExpiresAt:
          data.accessExpiresAt ||
          Date.now() + (data.expiresIn || 600) * 1000,
      };
      saveSession(next);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function buildHeaders(
  session: Session,
  extra?: HeadersInit,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extra as Record<string, string> | undefined),
  };
  if (session.accessToken) {
    headers.Authorization = `Bearer ${session.accessToken}`;
  }
  // Still send for img/SSE helpers & legacy
  if (session.username) headers["X-Flow-User"] = session.username;
  if (session.projectId) headers["X-Flow-Project"] = session.projectId;
  return headers;
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit & { session?: Session; skipRefresh?: boolean } = {},
): Promise<T> {
  const session = opts.session ?? loadSession();
  const { session: _s, skipRefresh, ...fetchOpts } = opts;

  // Proactive refresh if access expires within 30s
  if (
    !skipRefresh &&
    session.refreshToken &&
    session.accessExpiresAt &&
    session.accessExpiresAt < Date.now() + 30_000
  ) {
    await refreshAccessToken();
  }

  const run = async () => {
    const s = loadSession();
    const headers = buildHeaders(s, fetchOpts.headers as HeadersInit);
    return fetch(path, { ...fetchOpts, headers });
  };

  let res = await run();
  if (res.status === 401 && !skipRefresh && loadSession().refreshToken) {
    const ok = await refreshAccessToken();
    if (ok) res = await run();
  }

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  } & T;
  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string }).error || res.statusText,
      res.status,
      (data as { code?: string }).code,
    );
  }
  return data as T;
}

export async function applyAuthTokens(tokens: AuthTokens & { username?: string }) {
  const session = loadSession();
  saveSession({
    ...session,
    username: tokens.username || session.username,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt:
      tokens.accessExpiresAt ||
      Date.now() + (tokens.expiresIn || 600) * 1000,
  });
}

export { refreshAccessToken };
