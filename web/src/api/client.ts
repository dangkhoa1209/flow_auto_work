const SESSION_KEY = "flow_auto_work_session";

export type Session = {
  username: string | null;
  projectId: string | null;
};

export function loadSession(): Session {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { username: null, projectId: null };
    const parsed = JSON.parse(raw) as Session;
    return {
      username: parsed.username || null,
      projectId: parsed.projectId || null,
    };
  } catch {
    return { username: null, projectId: null };
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit & { session?: Session } = {},
): Promise<T> {
  const session = opts.session ?? loadSession();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (session.username) headers["X-Flow-User"] = session.username;
  if (session.projectId) headers["X-Flow-Project"] = session.projectId;

  const { session: _s, ...fetchOpts } = opts;
  const res = await fetch(path, { ...fetchOpts, headers });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string }).error || res.statusText,
      res.status,
    );
  }
  return data as T;
}
