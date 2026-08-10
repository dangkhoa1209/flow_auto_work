import { API } from "@/api/endpoints";
import { getAccessToken, loadPersistedAuth } from "@/api/tokenStorage";

export type RealtimeStatus = {
  type: "status";
  currentJobId: string | null;
  /** All running jobs (parallel lanes per project) */
  currentJobIds?: string[];
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

export type RealtimeChatMessage = {
  id?: string;
  jobId?: string;
  issueIid: number;
  role: "user" | "agent" | "system";
  kind: "clarify" | "qa" | "note";
  body: string;
  createdAt: string;
};

export type RealtimeChat = {
  type: "chat";
  jobId: string;
  message?: RealtimeChatMessage;
};

export type RealtimeBaMessage = {
  type: "ba_message";
  userId: string;
  threadId: string;
  message: {
    id: string;
    threadId: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
  };
};

export type RealtimeBaDelta = {
  type: "ba_delta";
  userId: string;
  threadId: string;
  messageId: string;
  delta: string;
};

export type RealtimeBaDone = {
  type: "ba_done";
  userId: string;
  threadId: string;
  messageId: string;
  content: string;
};

export type RealtimeBaError = {
  type: "ba_error";
  userId: string;
  threadId: string;
  messageId?: string;
  error: string;
};

type Handlers = {
  onStatus?: (ev: RealtimeStatus) => void;
  onProgress?: (ev: RealtimeProgress) => void;
  onJobs?: (ev: RealtimeJobs) => void;
  onJob?: (ev: RealtimeJob) => void;
  onChat?: (ev: RealtimeChat) => void;
  onBaMessage?: (ev: RealtimeBaMessage) => void;
  onBaDelta?: (ev: RealtimeBaDelta) => void;
  onBaDone?: (ev: RealtimeBaDone) => void;
  onBaError?: (ev: RealtimeBaError) => void;
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

  es.addEventListener("chat", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeChat;
      handlers.onChat?.(data);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("ba_message", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeBaMessage;
      handlers.onBaMessage?.(data);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("ba_delta", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeBaDelta;
      handlers.onBaDelta?.(data);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("ba_done", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeBaDone;
      handlers.onBaDone?.(data);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("ba_error", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as RealtimeBaError;
      handlers.onBaError?.(data);
    } catch {
      /* ignore */
    }
  });

  return () => {
    es.close();
  };
}
