import { API } from "@/api/endpoints";
import { refreshAccessToken } from "@/api/client";
import { getAccessExpiresAt, getAccessToken, loadPersistedAuth } from "@/api/tokenStorage";

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

export type RealtimeBaProgress = {
  type: "ba_progress";
  userId: string;
  threadId: string;
  messageId?: string;
  step: "pull" | "start" | "read" | "write" | "done" | "error";
  label: string;
  detail?: string;
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
  onBaProgress?: (ev: RealtimeBaProgress) => void;
  onOpen?: () => void;
  onError?: () => void;
};

function eventsUrl(): string {
  const persisted = loadPersistedAuth();
  const qs = new URLSearchParams();
  if (persisted.username) qs.set("u", persisted.username);
  if (persisted.projectId) qs.set("p", persisted.projectId);
  const access = getAccessToken();
  if (access) qs.set("access_token", access);
  return `${API.events}${qs.toString() ? `?${qs}` : ""}`;
}

async function ensureFreshAccessToken(): Promise<void> {
  const exp = getAccessExpiresAt();
  if (!getAccessToken() || (exp && exp < Date.now() + 20_000)) {
    await refreshAccessToken().catch(() => false);
  }
}

/**
 * SSE listen channel with explicit reconnect (tab close, mobile sleep, token expiry).
 * EventSource's built-in retry keeps a stale access_token in the URL.
 */
export function connectRealtime(handlers: Handlers): () => void {
  let stopped = false;
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let connecting = false;

  const bind = (source: EventSource) => {
    source.addEventListener("open", () => {
      attempt = 0;
      handlers.onOpen?.();
    });
    source.onerror = () => {
      handlers.onError?.();
      source.close();
      if (es === source) es = null;
      scheduleReconnect();
    };
    source.addEventListener("status", (e) => {
      try {
        handlers.onStatus?.(JSON.parse((e as MessageEvent).data) as RealtimeStatus);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("progress", (e) => {
      try {
        handlers.onProgress?.(
          JSON.parse((e as MessageEvent).data) as RealtimeProgress,
        );
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("jobs", (e) => {
      try {
        handlers.onJobs?.(JSON.parse((e as MessageEvent).data) as RealtimeJobs);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("job", (e) => {
      try {
        handlers.onJob?.(JSON.parse((e as MessageEvent).data) as RealtimeJob);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("chat", (e) => {
      try {
        handlers.onChat?.(JSON.parse((e as MessageEvent).data) as RealtimeChat);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("ba_message", (e) => {
      try {
        handlers.onBaMessage?.(
          JSON.parse((e as MessageEvent).data) as RealtimeBaMessage,
        );
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("ba_delta", (e) => {
      try {
        handlers.onBaDelta?.(
          JSON.parse((e as MessageEvent).data) as RealtimeBaDelta,
        );
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("ba_done", (e) => {
      try {
        handlers.onBaDone?.(JSON.parse((e as MessageEvent).data) as RealtimeBaDone);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("ba_error", (e) => {
      try {
        handlers.onBaError?.(
          JSON.parse((e as MessageEvent).data) as RealtimeBaError,
        );
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("ba_progress", (e) => {
      try {
        handlers.onBaProgress?.(
          JSON.parse((e as MessageEvent).data) as RealtimeBaProgress,
        );
      } catch {
        /* ignore */
      }
    });
  };

  const connect = async () => {
    if (stopped || connecting) return;
    connecting = true;
    try {
      await ensureFreshAccessToken();
      if (stopped) return;
      es?.close();
      es = new EventSource(eventsUrl());
      bind(es);
    } finally {
      connecting = false;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(800 * 2 ** attempt, 12_000);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };

  const wake = () => {
    if (stopped) return;
    if (document.visibilityState === "hidden") return;
    if (!es || es.readyState === EventSource.CLOSED) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      attempt = 0;
      void connect();
      return;
    }
    if (es.readyState === EventSource.OPEN) {
      handlers.onOpen?.();
    }
  };

  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);

  void connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
    window.removeEventListener("pageshow", wake);
    es?.close();
    es = null;
  };
}
