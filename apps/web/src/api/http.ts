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
  getAccessToken,
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
    return err.status === 401 || err.code === "SESSION_EXPIRED";
  }
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const code = (err.response?.data as { code?: string } | undefined)?.code;
    return status === 401 || code === "SESSION_EXPIRED";
  }
  return false;
}

/** Bare client — no interceptors (refresh must not recurse). */
const rawHttp = axios.create({
  timeout: 120_000,
  headers: { "Content-Type": "application/json" },
});

export async function refreshAccessTokenRaw(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) {
      throw new ApiError("No refresh token", 401, "SESSION_EXPIRED");
    }
    try {
      const res = await rawHttp.post<{
        accessToken: string;
        refreshToken?: string;
        expiresIn?: number;
        accessExpiresAt?: number;
        user?: { gitlabUsername?: string };
      }>(API.auth.refresh, { refreshToken });

      const data = res.data;
      if (!data.accessToken) {
        throw new ApiError(
          "Refresh missing accessToken",
          401,
          "SESSION_EXPIRED",
        );
      }
      const persisted = loadPersistedAuth();
      applyTokenPair({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
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
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
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
  (res) => res,
  async (error: AxiosError<{ error?: string; code?: string }>) => {
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

    if (!getRefreshToken()) {
      clearAuthAndNotify();
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
      // Only force logout on real auth failure — not network / 5xx blips
      if (isSessionExpiredError(apiErr)) {
        clearAuthAndNotify();
      }
      return Promise.reject(apiErr);
    } finally {
      isRefreshing = false;
    }
  },
);

function clearAuthAndNotify() {
  clearPersistedAuth();
  setAccessToken(null, null);
  try {
    message.warning("Session expired — please sign in again");
  } catch {
    /* antd may not be ready */
  }
  emitSessionExpired();
}

function toApiError(
  error: AxiosError<{ error?: string; code?: string }>,
): ApiError {
  const status = error.response?.status || 0;
  const data = error.response?.data;
  const msg =
    data?.error ||
    error.message ||
    (status ? `HTTP ${status}` : "Network error");
  return new ApiError(msg, status, data?.code);
}

export function clearAuthSession(): void {
  clearPersistedAuth();
  setAccessToken(null, null);
}

export async function request<T = unknown>(
  config: HttpRequestConfig,
): Promise<T> {
  const res = await http.request<T>(config);
  return res.data;
}
