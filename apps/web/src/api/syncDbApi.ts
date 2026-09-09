import { API } from "./endpoints";
import { request } from "./http";
import { getAccessToken } from "./tokenStorage";

export type SyncDbStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "timeout";

export type SyncDbProgress = {
  phase: string;
  total: number;
  done: number;
  current: string[];
  dbName: string;
};

export type SyncDbJob = {
  id: string;
  projectId: string;
  projectName: string;
  dbName: string;
  status: SyncDbStatus;
  triggeredBy: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  errorMessage?: string;
  cancelRequested?: boolean;
  progress: SyncDbProgress;
  targetHost: string;
  targetPort: number;
  createdAt: string;
  updatedAt: string;
};

export type SyncDbQueueSnapshot = {
  concurrency: 1;
  running: boolean;
  currentJobId: string | null;
  currentDbName: string | null;
  currentProgress: SyncDbProgress | null;
  queued: number;
  queuedIds: string[];
  shuttingDown: boolean;
};

export type SyncDbCapability = {
  available: boolean;
  reason?: string;
  systemConfigured: boolean;
  featureVisible: boolean;
  projectReady: boolean;
  dbName: string | null;
};

export type SyncDbSystemConfigPublic = {
  configured: boolean;
  enabled: boolean;
  sshHost: string | null;
  sshPort: number;
  sshUsername: string | null;
  hasSshPassword: boolean;
  hasSshPrivateKey: boolean;
  tunnelLocalPort: number;
  remoteMongoHost: string;
  remoteMongoPort: number;
  sourceUsername: string | null;
  hasSourcePassword: boolean;
  sourceAuthSource: string;
  dropTarget: boolean;
  timeoutSec: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type SyncDbLogLine = {
  at: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
};

export const syncDbApi = {
  capability(projectId: string) {
    const qs = new URLSearchParams({ projectId });
    return request<{
      capability: SyncDbCapability;
      queue: SyncDbQueueSnapshot;
    }>({ url: `${API.ba.syncDb.capability}?${qs}` });
  },

  queue() {
    return request<SyncDbQueueSnapshot>({ url: API.ba.syncDb.queue });
  },

  listJobs(opts?: {
    limit?: number;
    offset?: number;
    status?: SyncDbStatus;
    projectId?: string;
  }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.offset) qs.set("offset", String(opts.offset));
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.projectId) qs.set("projectId", opts.projectId);
    const q = qs.toString();
    return request<{
      queue: SyncDbQueueSnapshot;
      jobs: SyncDbJob[];
      total: number;
    }>({ url: q ? `${API.ba.syncDb.jobs}?${q}` : API.ba.syncDb.jobs });
  },

  trigger(projectId: string) {
    return request<{ job: SyncDbJob; queue: SyncDbQueueSnapshot }>({
      url: API.ba.syncDb.jobs,
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
  },

  cancel(id: string, projectId: string) {
    return request<{ job: SyncDbJob; queue: SyncDbQueueSnapshot }>({
      url: API.ba.syncDb.jobCancel(id),
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
  },

  getJob(id: string, projectId: string) {
    const qs = new URLSearchParams({ projectId });
    return request<{ job: SyncDbJob }>({
      url: `${API.ba.syncDb.job(id)}?${qs}`,
    });
  },

  getLog(id: string, projectId: string) {
    const qs = new URLSearchParams({ projectId });
    return request<{
      job: SyncDbJob;
      text: string;
      lines: SyncDbLogLine[];
    }>({ url: `${API.ba.syncDb.jobLog(id)}?${qs}` });
  },

  adminGetConfig() {
    return request<{ config: SyncDbSystemConfigPublic }>({
      url: API.admin.syncDb,
    });
  },

  adminPutConfig(body: Record<string, unknown>) {
    return request<{ config: SyncDbSystemConfigPublic }>({
      url: API.admin.syncDb,
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
};

export function syncDbEventsUrl(projectId: string): string {
  const qs = new URLSearchParams({ projectId });
  const access = getAccessToken();
  if (access) qs.set("access_token", access);
  return `${API.ba.syncDb.events}?${qs}`;
}

export function syncDbJobStreamUrl(id: string, projectId: string): string {
  const qs = new URLSearchParams({ projectId });
  const access = getAccessToken();
  if (access) qs.set("access_token", access);
  return `${API.ba.syncDb.jobStream(id)}?${qs}`;
}
