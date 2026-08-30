import { API } from "./endpoints";
import { request } from "./http";
import { getAccessToken } from "./tokenStorage";

export type BuildStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "timeout";

export type BuildScript = {
  id: string;
  label: string;
  command: string;
  workingDir: string;
  timeoutSec?: number;
  description?: string;
  active?: boolean;
};

export type BuildJob = {
  id: string;
  scriptId: string;
  scriptLabel: string;
  command: string;
  workingDir: string;
  status: BuildStatus;
  triggeredBy: string;
  note?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  errorMessage?: string;
  logFile: string;
  cancelRequested?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BuildQueueSnapshot = {
  concurrency: 1;
  running: boolean;
  currentBuildId: string | null;
  queued: number;
  queuedIds: string[];
  shuttingDown: boolean;
};

export type BuildLogLine = {
  at: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
};

export const devopsApi = {
  listScripts() {
    return request<{ scripts: BuildScript[] }>({ url: API.devops.scripts });
  },

  queue() {
    return request<BuildQueueSnapshot>({ url: API.devops.queue });
  },

  listBuilds(opts?: {
    limit?: number;
    offset?: number;
    status?: BuildStatus;
    scriptId?: string;
  }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.offset) qs.set("offset", String(opts.offset));
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.scriptId) qs.set("scriptId", opts.scriptId);
    const q = qs.toString();
    return request<{
      queue: BuildQueueSnapshot;
      builds: BuildJob[];
      total?: number;
    }>({
      url: q ? `${API.devops.builds}?${q}` : API.devops.builds,
    });
  },

  getBuild(id: string) {
    return request<{ job: BuildJob }>({ url: API.devops.build(id) });
  },

  trigger(scriptId: string, note?: string) {
    return request<{ job: BuildJob; queue: BuildQueueSnapshot }>({
      url: API.devops.builds,
      method: "POST",
      data: { scriptId, note },
    });
  },

  createScript(body: {
    id?: string;
    label: string;
    command: string;
    workingDir: string;
    timeoutSec?: number;
    description?: string;
    active?: boolean;
  }) {
    return request<{ script: BuildScript }>({
      url: API.devops.scripts,
      method: "POST",
      data: body,
    });
  },

  updateScript(
    id: string,
    body: {
      label?: string;
      command?: string;
      workingDir?: string;
      timeoutSec?: number;
      description?: string;
      active?: boolean;
    },
  ) {
    return request<{ script: BuildScript }>({
      url: API.devops.script(id),
      method: "PATCH",
      data: body,
    });
  },

  deleteScript(id: string) {
    return request<{ ok: boolean }>({
      url: API.devops.script(id),
      method: "DELETE",
    });
  },

  cancel(id: string) {
    return request<{ job: BuildJob; queue: BuildQueueSnapshot }>({
      url: API.devops.buildCancel(id),
      method: "POST",
      data: {},
    });
  },

  stdin(id: string, data: string, secret?: boolean) {
    return request<{ ok: boolean }>({
      url: API.devops.buildStdin(id),
      method: "POST",
      data: { data, secret: Boolean(secret) },
    });
  },

  log(id: string) {
    return request<{ job: BuildJob; text: string; lines: BuildLogLine[] }>({
      url: API.devops.buildLog(id),
    });
  },
};

export function devopsEventsUrl(): string {
  const qs = new URLSearchParams();
  const access = getAccessToken();
  if (access) qs.set("access_token", access);
  return `${API.devops.events}${qs.toString() ? `?${qs}` : ""}`;
}

export function devopsBuildStreamUrl(id: string): string {
  const qs = new URLSearchParams();
  const access = getAccessToken();
  if (access) qs.set("access_token", access);
  return `${API.devops.buildStream(id)}?${qs}`;
}
