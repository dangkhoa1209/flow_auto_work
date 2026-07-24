import { API } from "@/api/endpoints";
import { getAccessToken, loadPersistedAuth } from "@/api/tokenStorage";

export type RealtimeStatus = {
  type: "status";
  currentJobId: string | null;
  queueLength: number;
  running: boolean;
};

export type RealtimeProgress = {
  type: "progress";
  jobId: string;
  line: { id: number; at: string; kind: string; text: string };
  live: boolean;
};

export type RealtimeJobs = {
  type: "jobs";
  reason?: string;
  jobId?: string;
};

export type RealtimeJob = {
  type: "job";
  jobId: string;
  status?: string;
};

type Handlers = {
  onStatus?: (ev: RealtimeStatus) => void;
  onProgress?: (ev: RealtimeProgress) => void;
  onJobs?: (ev: RealtimeJobs) => void;
  onJob?: (ev: RealtimeJob) => void;
  onOpen?: () => void;
  onError?: () => void;
};

/**
 * SSE listen channel — replaces setInterval polling of /api/status + /api/jobs.
 * Auto-reconnects (browser EventSource default).
 */
export function connectRealtime(handlers: Handlers): () => void {
  const persisted = loadPersistedAuth();
  const qs = new URLSearchParams();
  if (persisted.username) qs.set("u", persisted.username);
  if (persisted.projectId) qs.set("p", persisted.projectId);
  const access = getAccessToken();
  if (access) qs.set("access_token", access);
  const url = `${API.events}${qs.toString() ? `?${qs}` : ""}`;

  const es = new EventSource(url);

  es.addEventListener("open", () => handlers.onOpen?.());
  es.onerror = () => handlers.onError?.();

  es.addEventListener("status", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeStatus;
      handlers.onStatus?.(data);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("progress", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeProgress;
      handlers.onProgress?.(data);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("jobs", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeJobs;
      handlers.onJobs?.(data);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("job", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeJob;
      handlers.onJob?.(data);
    } catch {
      /* ignore */
    }
  });

  return () => {
    es.close();
  };
}
