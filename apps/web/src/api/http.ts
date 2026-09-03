import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from "axios";
import { message } from "ant-design-vue";
import { API, PUBLIC_AUTH_PATHS } from "./endpoints";
import {
  applyTokenPair,
  clearPersistedAuth,
  clearPersistedAuthIfRefresh,
  getAccessToken,
  getAuthGeneration,
  getProjectId,
  getRefreshToken,
  getUsername,
  loadPersistedAuth,
  setAccessToken,
} from "./tokenStorage";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type HttpRequestConfig = AxiosRequestConfig & {
  skipAuth?: boolean;
  skipRefresh?: boolean;
  _retry?: boolean;
};

type QueueItem = {
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
};

let isRefreshing = false;
let failedQueue: QueueItem[] = [];
/** Single-flight: SSE reconnect + HTTP 401 share one refresh. */
let refreshInFlight: Promise<string> | null = null;

function processQueue(error: unknown, token: string | null) {
  for (const p of failedQueue) {
    if (error || !token) p.reject(error || new Error("refresh failed"));
    else p.resolve(token);
  }
  failedQueue = [];
}

/**
 * Drop in-flight refresh when tokens are replaced (login) or cleared.
 * Prevents a stale refresh promise from applying/clearing the new session.
 */
export function invalidateInFlightAuthRefresh(): void {
  refreshInFlight = null;
  isRefreshing = false;
  if (failedQueue.length) {
    processQueue(
      new ApiError("Auth session replaced", 409, "AUTH_RESET"),
      null,
    );
  }
}

function emitSessionExpired() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("flow:session-expired"));
  }
}

function isPublicPath(url?: string): boolean {
  if (!url) return false;
  const path = url.split("?")[0] || url;
  return PUBLIC_AUTH_PATHS.has(path);
}

function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.code === "AUTH_RESET" || err.code === "STALE_REFRESH") return false;
    return err.status === 401 || err.code === "SESSION_EXPIRED";
  }
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const code = (err.response?.data as { code?: string } | undefined)?.code;
    if (code === "AUTH_RESET" || code === "STALE_REFRESH") return false;
    return status === 401 || code === "SESSION_EXPIRED";
  }
  return false;
}

/** Bare client — no interceptors (refresh must not recurse). */
const rawHttp = axios.create({
  timeout: 120_000,
  headers: { "Content-Type": "application/json" },
});

/** Unwrap HTS-style `{ success, data }` envelopes from the API. */
export function unwrapApiData<T = unknown>(body: unknown): T {
  if (
    body &&
    typeof body === "object" &&
    "success" in body &&
    (body as { success?: unknown }).success === true &&
    "data" in body
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export async function refreshAccessTokenRaw(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;

  const refreshTokenUsed = getRefreshToken();
  if (!refreshTokenUsed) {
    throw new ApiError("No refresh token", 401, "SESSION_EXPIRED");
  }
  const generationAtStart = getAuthGeneration();

  const thisFlight = (async () => {
    try {
      const res = await rawHttp.post(API.auth.refresh, {
        refreshToken: refreshTokenUsed,
      });

      const data = unwrapApiData<{
        accessToken: string;
        refreshToken?: string;
        expiresIn?: number;
        accessExpiresAt?: number;
        user?: { gitlabUsername?: string };
      }>(res.data);
      if (!data.accessToken) {
        throw new ApiError(
          "Refresh missing accessToken",
          401,
          "SESSION_EXPIRED",
        );
      }
      // Login may have replaced the session while this refresh was in flight.
      if (getAuthGeneration() !== generationAtStart) {
        throw new ApiError(
          "Stale refresh discarded",
          409,
          "STALE_REFRESH",
        );
      }
      const currentRt = getRefreshToken();
      if (currentRt && currentRt !== refreshTokenUsed) {
        throw new ApiError(
          "Stale refresh discarded",
          409,
          "STALE_REFRESH",
        );
      }
      const persisted = loadPersistedAuth();
      applyTokenPair({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshTokenUsed,
        expiresIn: data.expiresIn,
        accessExpiresAt: data.accessExpiresAt,
        username: data.user?.gitlabUsername || persisted.username,
      });
      return data.accessToken;
    } catch (err) {
      if (isSessionExpiredError(err)) {
        throw err instanceof ApiError
          ? err
          : new ApiError(
              "Session expired — please sign in again",
              401,
              "SESSION_EXPIRED",
            );
      }
      throw err;
    } finally {
      if (refreshInFlight === thisFlight) refreshInFlight = null;
    }
  })();

  refreshInFlight = thisFlight;
  return thisFlight;
}

export const http: AxiosInstance = axios.create({
  timeout: 120_000,
  headers: { "Content-Type": "application/json" },
});

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const cfg = config as InternalAxiosRequestConfig & HttpRequestConfig;
  const url = cfg.url || "";
  const skipAuth = cfg.skipAuth || isPublicPath(url);

  if (!skipAuth) {
    const token = getAccessToken();
    if (token) {
      cfg.headers.Authorization = `Bearer ${token}`;
    }
  }

  const username = getUsername();
  const projectId = getProjectId();
  if (username) cfg.headers["X-Flow-User"] = username;
  if (projectId) cfg.headers["X-Flow-Project"] = projectId;

  return cfg;
});

http.interceptors.response.use(
  (res) => {
    if (
      res.data &&
      typeof res.data === "object" &&
      (res.data as { success?: unknown }).success === true &&
      "data" in (res.data as object)
    ) {
      res.data = (res.data as { data: unknown }).data;
    }
    return res;
  },
  async (error: AxiosError<{ error?: string; message?: string; code?: string }>) => {
    const original = error.config as
      | (InternalAxiosRequestConfig & HttpRequestConfig)
      | undefined;
    const status = error.response?.status;

    if (!original || status !== 401) {
      return Promise.reject(toApiError(error));
    }
    if (original.skipRefresh || isPublicPath(original.url)) {
      return Promise.reject(toApiError(error));
    }
    if (original._retry) {
      return Promise.reject(toApiError(error));
    }

    const refreshTokenForAttempt = getRefreshToken();
    if (!refreshTokenForAttempt) {
      clearAuthAndNotify(null, getAuthGeneration());
      return Promise.reject(
        new ApiError(
          "Session expired — please sign in again",
          401,
          "SESSION_EXPIRED",
        ),
      );
    }

    if (isRefreshing) {
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((token) => {
        original.headers.Authorization = `Bearer ${token}`;
        original._retry = true;
        return http(original);
      });
    }

    original._retry = true;
    isRefreshing = true;
    const generationAtStart = getAuthGeneration();
    try {
      const token = await refreshAccessTokenRaw();
      processQueue(null, token);
      original.headers.Authorization = `Bearer ${token}`;
      return http(original);
    } catch (err) {
      const apiErr = isSessionExpiredError(err)
        ? err instanceof ApiError
          ? err
          : new ApiError(
              "Session expired — please sign in again",
              401,
              "SESSION_EXPIRED",
            )
        : toApiError(err as AxiosError<{ error?: string; code?: string }>);
      processQueue(apiErr, null);
      // Only force logout on real auth failure — not network / 5xx / stale-refresh
      if (isSessionExpiredError(apiErr)) {
        clearAuthAndNotify(refreshTokenForAttempt, generationAtStart);
      }
      return Promise.reject(apiErr);
    } finally {
      isRefreshing = false;
    }
  },
);

/**
 * Wipe session after auth failure. No-op if a newer login already replaced
 * the session (generation bump or different refresh token).
 */
function clearAuthAndNotify(
  failedRefreshToken: string | null,
  generationAtStart: number,
) {
  if (getAuthGeneration() !== generationAtStart) {
    return;
  }
  const current = getRefreshToken();
  if (current && current !== failedRefreshToken) {
    return;
  }
  invalidateInFlightAuthRefresh();
  if (!clearPersistedAuthIfRefresh(failedRefreshToken)) {
    return;
  }
  // Login may have written tokens between the checks above and clear.
  if (getAuthGeneration() !== generationAtStart || getRefreshToken()) {
    return;
  }
  setAccessToken(null, null);
  try {
    message.warning("Session expired — please sign in again");
  } catch {
    /* antd may not be ready */
  }
  emitSessionExpired();
}

function toApiError(
  error: AxiosError<{ error?: string; message?: string; code?: string }>,
): ApiError {
  const status = error.response?.status || 0;
  const data = error.response?.data;
  const msg =
    data?.error ||
    data?.message ||
    error.message ||
    (status ? `HTTP ${status}` : "Network error");
  return new ApiError(msg, status, data?.code != null ? String(data.code) : undefined);
}

export function clearAuthSession(): void {
  invalidateInFlightAuthRefresh();
  clearPersistedAuth();
  setAccessToken(null, null);
}

export async function request<T = unknown>(
  config: HttpRequestConfig,
): Promise<T> {
  const res = await http.request(config);
  return unwrapApiData<T>(res.data);
}
