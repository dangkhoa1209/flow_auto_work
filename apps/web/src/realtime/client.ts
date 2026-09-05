import { API } from "@/api/endpoints";
import { refreshAccessToken } from "@/api/client";
import { recoverAuthRefreshLocks } from "@/api/http";
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

export type RealtimeBaIssueDraftProgress = {
  type: "ba_issue_draft_progress";
  userId: string;
  threadId: string;
  label: string;
  step?: string;
};

export type RealtimeBaIssueDraftDone = {
  type: "ba_issue_draft_done";
  userId: string;
  threadId: string;
  baProjectId: string;
  cached: boolean;
  draft: {
    title: string;
    description: string;
    labels: string[];
    acceptanceCriteria: string[];
  };
};

export type RealtimeBaIssueDraftError = {
  type: "ba_issue_draft_error";
  userId: string;
  threadId: string;
  error: string;
};

export type RealtimeBaWfStepProgress = {
  type: "ba_wf_step_progress";
  userId: string;
  requirementId: string;
  step: string;
  label: string;
};

export type RealtimeBaWfStepDone = {
  type: "ba_wf_step_done";
  userId: string;
  requirementId: string;
  step: string;
  requirement: import("@/api/baApi").BaRequirement;
  taskDrafts: import("@/api/baApi").BaTaskDraft[];
  gate: { status: "ok" | "blocked" | "invalid"; openQuestions: string[] };
};

export type RealtimeBaWfStepError = {
  type: "ba_wf_step_error";
  userId: string;
  requirementId: string;
  step: string;
  error: string;
};

export type RealtimeHandlers = {
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
  onBaIssueDraftProgress?: (ev: RealtimeBaIssueDraftProgress) => void;
  onBaIssueDraftDone?: (ev: RealtimeBaIssueDraftDone) => void;
  onBaIssueDraftError?: (ev: RealtimeBaIssueDraftError) => void;
  onBaWfStepProgress?: (ev: RealtimeBaWfStepProgress) => void;
  onBaWfStepDone?: (ev: RealtimeBaWfStepDone) => void;
  onBaWfStepError?: (ev: RealtimeBaWfStepError) => void;
  onOpen?: () => void;
  onError?: () => void;
};

/** @deprecated use RealtimeHandlers */
type Handlers = RealtimeHandlers;

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
  recoverAuthRefreshLocks();
  const exp = getAccessExpiresAt();
  if (!getAccessToken() || (exp && exp < Date.now() + 20_000)) {
    await refreshAccessToken().catch(() => false);
  }
}

const subscribers = new Set<RealtimeHandlers>();

let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let connecting = false;
let stopped = true;
let wakeBound = false;

function fanout<K extends keyof RealtimeHandlers>(
  key: K,
  ...args: Parameters<NonNullable<RealtimeHandlers[K]>>
) {
  for (const h of subscribers) {
    const fn = h[key];
    if (typeof fn === "function") {
      try {
        (fn as (...a: typeof args) => void)(...args);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }
}

function bind(source: EventSource) {
  source.addEventListener("open", () => {
    attempt = 0;
    fanout("onOpen");
  });
  source.onerror = () => {
    fanout("onError");
    source.close();
    if (es === source) es = null;
    scheduleReconnect();
  };
  const listen = <T>(type: string, key: keyof RealtimeHandlers) => {
    source.addEventListener(type, (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as T;
        fanout(key, data as never);
      } catch {
        /* ignore */
      }
    });
  };
  listen<RealtimeStatus>("status", "onStatus");
  listen<RealtimeProgress>("progress", "onProgress");
  listen<RealtimeJobs>("jobs", "onJobs");
  listen<RealtimeJob>("job", "onJob");
  listen<RealtimeChat>("chat", "onChat");
  listen<RealtimeBaMessage>("ba_message", "onBaMessage");
  listen<RealtimeBaDelta>("ba_delta", "onBaDelta");
  listen<RealtimeBaDone>("ba_done", "onBaDone");
  listen<RealtimeBaError>("ba_error", "onBaError");
  listen<RealtimeBaProgress>("ba_progress", "onBaProgress");
  listen<RealtimeBaIssueDraftProgress>(
    "ba_issue_draft_progress",
    "onBaIssueDraftProgress",
  );
  listen<RealtimeBaIssueDraftDone>("ba_issue_draft_done", "onBaIssueDraftDone");
  listen<RealtimeBaIssueDraftError>(
    "ba_issue_draft_error",
    "onBaIssueDraftError",
  );
  listen<RealtimeBaWfStepProgress>("ba_wf_step_progress", "onBaWfStepProgress");
  listen<RealtimeBaWfStepDone>("ba_wf_step_done", "onBaWfStepDone");
  listen<RealtimeBaWfStepError>("ba_wf_step_error", "onBaWfStepError");
}

async function connect() {
  if (stopped || connecting || subscribers.size === 0) return;
  connecting = true;
  try {
    await ensureFreshAccessToken();
    if (stopped || subscribers.size === 0) return;
    es?.close();
    es = new EventSource(eventsUrl());
    bind(es);
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer || subscribers.size === 0) return;
  const delay = Math.min(800 * 2 ** attempt, 12_000);
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, delay);
}

function wake() {
  if (stopped || subscribers.size === 0) return;
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
    fanout("onOpen");
  }
}

function bindWakeListeners() {
  if (wakeBound) return;
  wakeBound = true;
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
}

function unbindWakeListeners() {
  if (!wakeBound) return;
  wakeBound = false;
  document.removeEventListener("visibilitychange", wake);
  window.removeEventListener("online", wake);
  window.removeEventListener("pageshow", wake);
}

function startHub() {
  if (!stopped) return;
  stopped = false;
  bindWakeListeners();
  attempt = 0;
  void connect();
}

function stopHub() {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  unbindWakeListeners();
  es?.close();
  es = null;
  connecting = false;
  attempt = 0;
}

/**
 * Subscribe to the shared SSE channel (one EventSource for the whole app).
 * Stays open across Chat ↔ Work navigation; closes when the last subscriber leaves.
 */
export function subscribeRealtime(handlers: RealtimeHandlers): () => void {
  subscribers.add(handlers);
  startHub();
  return () => {
    subscribers.delete(handlers);
    if (subscribers.size === 0) stopHub();
  };
}

/** Force reconnect (e.g. workbench project switch — URL embeds project id). */
export function reconnectRealtime(): void {
  if (subscribers.size === 0) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  attempt = 0;
  es?.close();
  es = null;
  stopped = false;
  bindWakeListeners();
  void connect();
}

/**
 * @deprecated Prefer subscribeRealtime — kept for call sites that expect connectRealtime.
 */
export function connectRealtime(handlers: Handlers): () => void {
  return subscribeRealtime(handlers);
}
