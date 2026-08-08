import type { QcStep } from "../shared/types";

/** Same backend as web FE Vite proxy (`/api` → :8787). Not user-configurable. */
export const API_BASE = "http://127.0.0.1:8787";

const CFG_KEY = "qcExtConfig";

export type ExtConfig = {
  accessToken: string;
  refreshToken: string;
  username: string;
  qcProjectId: string;
};

export async function loadConfig(): Promise<ExtConfig> {
  const data = await chrome.storage.local.get(CFG_KEY);
  const c = (data[CFG_KEY] || {}) as Partial<ExtConfig> & { apiBase?: string };
  return {
    accessToken: c.accessToken || "",
    refreshToken: c.refreshToken || "",
    username: c.username || "",
    qcProjectId: c.qcProjectId || "",
  };
}

export async function saveConfig(cfg: ExtConfig): Promise<void> {
  await chrome.storage.local.set({ [CFG_KEY]: cfg });
  await chrome.storage.session.set({
    qcPlayEnv: {
      apiBase: API_BASE,
      accessToken: cfg.accessToken,
      qcProjectId: cfg.qcProjectId,
    },
  });
}

async function rawFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (body as { error?: string }).error || `HTTP ${res.status}`,
    );
  }
  return body as T;
}

export type LoginResult = {
  accessToken: string;
  refreshToken: string;
  user?: { gitlabUsername?: string; roles?: string[] };
};

/** Login WorkBench — cùng BE với web FE. */
export async function login(
  username: string,
  password: string,
): Promise<LoginResult> {
  return rawFetch<LoginResult>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function enableQcRole(cfg: ExtConfig): Promise<void> {
  await qcFetch("/api/me/qc-role", cfg, {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
}

export async function fetchMe(cfg: ExtConfig): Promise<{
  user?: { gitlabUsername?: string; roles?: string[] };
}> {
  return qcFetch("/api/me", cfg);
}

async function qcFetch<T>(
  path: string,
  cfg: ExtConfig,
  init?: RequestInit,
): Promise<T> {
  if (!cfg.accessToken.trim()) {
    throw new Error("Chưa đăng nhập — nhập username/password rồi bấm Login");
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.accessToken}`,
      ...(cfg.qcProjectId ? { "X-Qc-Project": cfg.qcProjectId } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error || `HTTP ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return undefined as T;
  return res.json() as Promise<T>;
}

export async function listFlows(cfg: ExtConfig) {
  return qcFetch<{ flows: { _id: string; name: string; steps: QcStep[] }[] }>(
    "/api/qc/flows",
    cfg,
  );
}

export async function listTestCases(cfg: ExtConfig) {
  return qcFetch<{
    testCases: {
      _id: string;
      name: string;
      loopCount: number;
      executionPlan: Array<
        | { type: "navigate"; url: string }
        | { type: "run_flow"; flowId: string }
      >;
    }[];
  }>("/api/qc/test-cases", cfg);
}

export async function listProjects(cfg: ExtConfig) {
  return qcFetch<{
    projects: { _id: string; name: string; targetBaseUrl: string }[];
  }>("/api/qc/projects", cfg);
}

export async function saveFlow(
  cfg: ExtConfig,
  data: { name: string; steps: QcStep[] },
) {
  return qcFetch("/api/qc/flows", cfg, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getFlow(cfg: ExtConfig, flowId: string) {
  return qcFetch<{ _id: string; name: string; steps: QcStep[] }>(
    `/api/qc/flows/${encodeURIComponent(flowId)}`,
    cfg,
  );
}

export async function logoutLocal(cfg: ExtConfig): Promise<ExtConfig> {
  const next: ExtConfig = {
    ...cfg,
    accessToken: "",
    refreshToken: "",
    username: "",
  };
  await saveConfig(next);
  return next;
}
