import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";
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

const raw = axios.create({ timeout: 120_000 });

export async function refreshAccessTokenRaw(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new ApiError("No refresh token", 401);
  const res = await raw.post("/api/auth/refresh", { refreshToken });
  const data = res.data as {
    accessToken: string;
    refreshToken?: string;
    user?: { gitlabUsername?: string };
  };
  applyTokenPair({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || refreshToken,
    username: data.user?.gitlabUsername || loadPersistedAuth().username,
  });
  return data.accessToken;
}

export const http = axios.create({
  timeout: 120_000,
  headers: { "Content-Type": "application/json" },
});

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const username = getUsername();
  const projectId = getProjectId();
  if (username) config.headers["X-Flow-User"] = username;
  if (projectId) config.headers["X-Flow-Project"] = projectId;
  // Debug aid: surface missing auth early in console (dev only)
  if (
    import.meta.env.DEV &&
    config.url?.startsWith("/api/qa") &&
    (!token || !projectId)
  ) {
    console.warn("[qa-http] missing auth for", config.url, {
      hasToken: Boolean(token),
      projectId,
      username,
    });
  }
  return config;
});

http.interceptors.response.use(
  (r) => r,
  async (error: AxiosError<{ error?: string; message?: string; code?: string }>) => {
    const original = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };
    if (!original || error.response?.status !== 401 || original._retry) {
      const msg =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message;
      return Promise.reject(
        new ApiError(msg, error.response?.status || 0, error.response?.data?.code),
      );
    }
    if (!getRefreshToken()) {
      clearPersistedAuth();
      setAccessToken(null);
      return Promise.reject(new ApiError("Session expired", 401));
    }
    original._retry = true;
    try {
      const token = await refreshAccessTokenRaw();
      original.headers.Authorization = `Bearer ${token}`;
      return http(original);
    } catch {
      clearPersistedAuth();
      setAccessToken(null);
      return Promise.reject(new ApiError("Session expired", 401));
    }
  },
);

export async function request<T>(config: {
  url: string;
  method?: string;
  data?: unknown;
}): Promise<T> {
  const res = await http.request<T>(config);
  return res.data;
}
