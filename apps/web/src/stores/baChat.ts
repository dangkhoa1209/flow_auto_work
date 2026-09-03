import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";
import { safeGetItem, safeSetItem, safeRemoveItem } from "@/utils/safeStorage";

export type BaProject = {
  id: string;
  slug: string;
  displayName: string;
  gitlabPath: string;
  cloneStatus: string;
  cloneError: string | null;
  ready?: boolean;
  db?: {
    configured: boolean;
    enabled: boolean;
    dialect: string | null;
    database: string | null;
  };
};

export type BaFeatureState = "hide" | "lab" | "production";

export type BaFeatureKey = "createIssue" | "workflow" | "tasks";

export type BaFeatures = {
  flags: Record<BaFeatureKey, BaFeatureState>;
  workflowTabLabel: string;
  devMode: boolean;
};

const DEFAULT_BA_FEATURES: BaFeatures = {
  flags: { createIssue: "hide", workflow: "hide", tasks: "hide" },
  workflowTabLabel: "Phân tích YC",
  devMode: false,
};

export type BaThread = {
  id: string;
  userId: string;
  baProjectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type BaMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type BaProgressStep =
  | "pull"
  | "start"
  | "read"
  | "write"
  | "done"
  | "error";

export type BaProgressItem = {
  step: BaProgressStep;
  label: string;
  detail?: string;
  at: string;
};

const STEP_ORDER: BaProgressStep[] = [
  "pull",
  "start",
  "read",
  "write",
  "done",
];

export const useBaChatStore = defineStore("baChat", () => {
  const session = useSessionStore();

  const projects = ref<BaProject[]>([]);
  const selectedProjectId = ref<string | null>(
    safeGetItem("flow_ba_project_id"),
  );
  const threads = ref<BaThread[]>([]);
  const activeThreadId = ref<string | null>(null);
  const messages = ref<BaMessage[]>([]);
  const streaming = ref(false);
  const streamingMessageId = ref<string | null>(null);
  const stopBusy = ref(false);
  const loading = ref(false);
  const errorText = ref("");
  const progress = ref<BaProgressItem[]>([]);
  const progressVisible = ref(false);
  /** BA analysis mode — agent acts as real BA for requirements analysis */
  const analysisMode = ref(safeGetItem("flow_ba_analysis_mode") === "1");
  /** Feature flags do admin cấu hình (hide|lab|production), dev mode mở hết */
  const features = ref<BaFeatures>({ ...DEFAULT_BA_FEATURES });
  const featuresLoaded = ref(false);

  /** Create-issue from thread: agent runs in background; modal waits on SSE */
  const issueDrafting = ref(false);
  const issueDraftThreadId = ref<string | null>(null);
  const issueDraftLabel = ref("");
  const issueDraftError = ref("");
  const issueDraftResult = ref<{
    threadId: string;
    baProjectId: string;
    cached: boolean;
    draft: {
      title: string;
      description: string;
      labels: string[];
      acceptanceCriteria: string[];
    };
  } | null>(null);

  function clearIssueDraft() {
    issueDrafting.value = false;
    issueDraftThreadId.value = null;
    issueDraftLabel.value = "";
    issueDraftError.value = "";
    issueDraftResult.value = null;
  }

  function beginIssueDraft(threadId: string) {
    issueDrafting.value = true;
    issueDraftThreadId.value = threadId;
    issueDraftLabel.value = "Reviewing conversation…";
    issueDraftError.value = "";
    issueDraftResult.value = null;
  }

  function setAnalysisMode(on: boolean) {
    analysisMode.value = on;
    safeSetItem("flow_ba_analysis_mode", on ? "1" : "0");
  }

  const selectedProject = computed(() =>
    projects.value.find((p) => p.id === selectedProjectId.value) || null,
  );

  const activeThread = computed(() =>
    threads.value.find((t) => t.id === activeThreadId.value) || null,
  );

  const projectReady = computed(() =>
    Boolean(selectedProject.value?.ready),
  );

  const currentProgressLabel = computed(() => {
    const last = progress.value[progress.value.length - 1];
    return last?.label || (streaming.value ? "Đang xử lý…" : "");
  });

  const progressPct = computed(() => {
    const last = progress.value[progress.value.length - 1];
    if (!last) return streaming.value ? 8 : 0;
    if (last.step === "error") return 100;
    const idx = STEP_ORDER.indexOf(last.step);
    if (idx < 0) return 12;
    return Math.min(100, Math.round(((idx + 1) / STEP_ORDER.length) * 100));
  });

  function clearProgress() {
    progress.value = [];
    progressVisible.value = false;
  }

  function persistProjectId(id: string | null) {
    selectedProjectId.value = id;
    if (id) safeSetItem("flow_ba_project_id", id);
    else safeRemoveItem("flow_ba_project_id");
  }

  /** Tính năng có hiển thị với người dùng không (lab vẫn hiện, kèm nhãn). */
  function featureVisible(key: BaFeatureKey): boolean {
    return features.value.flags[key] !== "hide";
  }

  /** Nhãn kèm "(lab)" khi tính năng đang thử nghiệm. */
  function featureLabel(key: BaFeatureKey, base: string): string {
    return features.value.flags[key] === "lab" ? `${base} (lab)` : base;
  }

  async function loadProjects() {
    const data = await api<{ projects?: BaProject[]; features?: BaFeatures }>(
      API.ba.projects,
    );
    projects.value = data.projects || [];
    if (data.features) {
      features.value = {
        ...DEFAULT_BA_FEATURES,
        ...data.features,
        flags: { ...DEFAULT_BA_FEATURES.flags, ...(data.features.flags || {}) },
      };
    }
    featuresLoaded.value = true;
    if (
      selectedProjectId.value &&
      !projects.value.some((p) => p.id === selectedProjectId.value)
    ) {
      persistProjectId(null);
    }
    if (!selectedProjectId.value && projects.value[0]) {
      persistProjectId(projects.value[0].id);
    }
  }

  async function loadThreads() {
    if (!selectedProjectId.value) {
      threads.value = [];
      activeThreadId.value = null;
      messages.value = [];
      return;
    }
    const qs = `?baProjectId=${encodeURIComponent(selectedProjectId.value)}`;
    const data = await api<{ threads?: BaThread[] }>(`${API.ba.threads}${qs}`);
    const uid = currentUserId();
    // Defense: never show another user's threads in the sidebar
    threads.value = (data.threads || []).filter(
      (t) => !uid || t.userId.toLowerCase() === uid,
    );
    if (
      activeThreadId.value &&
      !threads.value.some((t) => t.id === activeThreadId.value)
    ) {
      activeThreadId.value = null;
      messages.value = [];
      streaming.value = false;
      streamingMessageId.value = null;
      clearProgress();
    }
  }

  /** Clear all BA chat state (call on logout / user switch). */
  function reset() {
    projects.value = [];
    features.value = { ...DEFAULT_BA_FEATURES };
    featuresLoaded.value = false;
    threads.value = [];
    activeThreadId.value = null;
    messages.value = [];
    streaming.value = false;
    streamingMessageId.value = null;
    stopBusy.value = false;
    loading.value = false;
    errorText.value = "";
    clearProgress();
    clearIssueDraft();
  }

  async function stop() {
    const threadId = activeThreadId.value;
    if (!threadId || !streaming.value || stopBusy.value) return;
    stopBusy.value = true;
    try {
      await api<{ ok?: boolean; cancelled?: boolean }>(API.ba.stop(threadId), {
        method: "POST",
      });
    } finally {
      stopBusy.value = false;
    }
  }

  function currentUserId(): string {
    return (
      session.me?.id ||
      session.me?.gitlabUsername ||
      session.session.username ||
      ""
    )
      .toLowerCase()
      .replace(/^@/, "");
  }

  /** Strict: drop events if we can't prove they belong to the logged-in user. */
  function isMyEvent(userId: string | undefined): boolean {
    const uid = currentUserId();
    if (!uid || !userId) return false;
    return userId.toLowerCase() === uid;
  }

  async function selectProject(id: string) {
    persistProjectId(id);
    activeThreadId.value = null;
    messages.value = [];
    await loadThreads();
  }

  async function selectThread(id: string) {
    activeThreadId.value = id;
    loading.value = true;
    errorText.value = "";
    try {
      const data = await api<{
        messages?: BaMessage[];
        thread?: BaThread;
      }>(API.ba.messages(id));
      messages.value = data.messages || [];
      if (data.thread) {
        const idx = threads.value.findIndex((t) => t.id === data.thread!.id);
        if (idx >= 0) threads.value[idx] = data.thread;
      }
    } catch (e) {
      errorText.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function newChat() {
    if (!selectedProjectId.value) {
      throw new Error("Chọn project trước");
    }
    if (!projectReady.value) {
      throw new Error("Project chưa sẵn sàng — liên hệ admin");
    }
    const data = await api<{ thread?: BaThread }>(API.ba.threads, {
      method: "POST",
      body: JSON.stringify({ baProjectId: selectedProjectId.value }),
    });
    if (!data.thread) throw new Error("Failed to create chat");
    threads.value = [data.thread, ...threads.value];
    activeThreadId.value = data.thread.id;
    messages.value = [];
    return data.thread;
  }

  async function deleteThread(id: string) {
    await api(API.ba.thread(id), { method: "DELETE" });
    threads.value = threads.value.filter((t) => t.id !== id);
    if (activeThreadId.value === id) {
      activeThreadId.value = null;
      messages.value = [];
    }
  }

  async function sendMessage(content: string) {
    const text = content.trim();
    if (!text) return;
    if (!activeThreadId.value) {
      await newChat();
    }
    const threadId = activeThreadId.value!;
    streaming.value = true;
    errorText.value = "";
    clearProgress();
    progressVisible.value = true;
    progress.value = [
      {
        step: "pull",
        label: "Đang gửi câu hỏi…",
        at: new Date().toISOString(),
      },
    ];
    try {
      const data = await api<{ message?: BaMessage }>(API.ba.messages(threadId), {
        method: "POST",
        body: JSON.stringify({
          content: text,
          analysisMode: analysisMode.value,
        }),
      });
      if (data.message) {
        const exists = messages.value.some((m) => m.id === data.message!.id);
        if (!exists) messages.value.push(data.message);
      }
    } catch (e) {
      streaming.value = false;
      errorText.value = e instanceof Error ? e.message : String(e);
      clearProgress();
      throw e;
    }
  }

  /** Thread thuộc tab Chat (đã load) — bỏ qua SSE của chat workflow. */
  function isChatTabThread(threadId: string): boolean {
    return (
      threadId === activeThreadId.value ||
      threads.value.some((t) => t.id === threadId)
    );
  }

  function applyBaMessage(ev: {
    userId: string;
    threadId: string;
    message: BaMessage;
  }) {
    if (!isMyEvent(ev.userId)) return;
    if (!isChatTabThread(ev.threadId)) return;
    if (ev.threadId !== activeThreadId.value) {
      void loadThreads();
      return;
    }
    const idx = messages.value.findIndex((m) => m.id === ev.message.id);
    if (idx >= 0) {
      const prev = messages.value[idx];
      // Don't wipe streamed text if a late empty placeholder arrives
      if (!ev.message.content && prev.content) {
        streamingMessageId.value = ev.message.id;
        streaming.value = true;
        return;
      }
      messages.value[idx] = ev.message;
    } else {
      messages.value.push(ev.message);
    }
    if (ev.message.role === "assistant" && !ev.message.content) {
      streamingMessageId.value = ev.message.id;
      streaming.value = true;
    }
  }

  function applyBaDelta(ev: {
    userId: string;
    threadId: string;
    messageId: string;
    delta: string;
  }) {
    if (!isMyEvent(ev.userId)) return;
    if (ev.threadId !== activeThreadId.value) return;
    streaming.value = true;
    streamingMessageId.value = ev.messageId;
    const idx = messages.value.findIndex((m) => m.id === ev.messageId);
    if (idx >= 0) {
      messages.value[idx] = {
        ...messages.value[idx],
        content: messages.value[idx].content + ev.delta,
      };
    } else {
      messages.value.push({
        id: ev.messageId,
        threadId: ev.threadId,
        role: "assistant",
        content: ev.delta,
        createdAt: new Date().toISOString(),
      });
    }
  }

  function applyBaDone(ev: {
    userId: string;
    threadId: string;
    messageId: string;
    content: string;
  }) {
    if (!isMyEvent(ev.userId)) return;
    if (!isChatTabThread(ev.threadId)) return;
    if (ev.threadId === activeThreadId.value) {
      const idx = messages.value.findIndex((m) => m.id === ev.messageId);
      const prev = idx >= 0 ? messages.value[idx].content : "";
      let finalContent = ev.content?.trim()
        ? ev.content
        : prev || ev.content;
      // Prefer longer in-memory stream if stop note would wipe it
      if (
        prev &&
        finalContent &&
        prev.length > finalContent.length &&
        /⏹ Đã dừng/.test(finalContent)
      ) {
        finalContent = `${prev.trim()}\n\n⏹ Đã dừng theo yêu cầu.`;
      }
      if (idx >= 0) {
        messages.value[idx] = {
          ...messages.value[idx],
          content: finalContent,
        };
      } else if (finalContent) {
        messages.value.push({
          id: ev.messageId,
          threadId: ev.threadId,
          role: "assistant",
          content: finalContent,
          createdAt: new Date().toISOString(),
        });
      }
    }
    streaming.value = false;
    streamingMessageId.value = null;
    errorText.value = "";
    void loadThreads();
    window.setTimeout(() => {
      if (!streaming.value) clearProgress();
    }, 1200);
  }

  function applyBaError(ev: {
    userId: string;
    threadId: string;
    messageId?: string;
    error: string;
  }) {
    if (!isMyEvent(ev.userId)) return;
    if (!isChatTabThread(ev.threadId)) return;
    if (ev.threadId === activeThreadId.value) {
      errorText.value = ev.error;
      if (ev.messageId) {
        const idx = messages.value.findIndex((m) => m.id === ev.messageId);
        if (idx >= 0 && !messages.value[idx].content) {
          messages.value[idx] = {
            ...messages.value[idx],
            content: `⚠️ ${ev.error}`,
          };
        }
      }
    }
    streaming.value = false;
    streamingMessageId.value = null;
  }

  function applyBaProgress(ev: {
    userId: string;
    threadId: string;
    messageId?: string;
    step: BaProgressStep;
    label: string;
    detail?: string;
  }) {
    if (!isMyEvent(ev.userId)) return;
    if (!isChatTabThread(ev.threadId)) return;
    if (ev.threadId !== activeThreadId.value) return;
    progressVisible.value = true;
    const item: BaProgressItem = {
      step: ev.step,
      label: ev.label,
      detail: ev.detail,
      at: new Date().toISOString(),
    };
    const idx = progress.value.findIndex((p) => p.step === ev.step);
    if (idx >= 0) progress.value[idx] = item;
    else progress.value = [...progress.value, item];
    if (ev.step === "done") {
      window.setTimeout(() => {
        if (!streaming.value) clearProgress();
      }, 900);
    }
  }

  function applyBaIssueDraftProgress(ev: {
    userId: string;
    threadId: string;
    label: string;
    step?: string;
  }) {
    if (!isMyEvent(ev.userId)) return;
    if (
      issueDraftThreadId.value &&
      ev.threadId !== issueDraftThreadId.value
    ) {
      return;
    }
    issueDrafting.value = true;
    issueDraftThreadId.value = ev.threadId;
    issueDraftLabel.value = ev.label || "Drafting issue…";
  }

  function applyBaIssueDraftDone(ev: {
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
  }) {
    if (!isMyEvent(ev.userId)) return;
    if (
      issueDraftThreadId.value &&
      ev.threadId !== issueDraftThreadId.value
    ) {
      return;
    }
    issueDraftResult.value = {
      threadId: ev.threadId,
      baProjectId: ev.baProjectId,
      cached: ev.cached,
      draft: ev.draft,
    };
    issueDrafting.value = false;
    issueDraftLabel.value = "";
    issueDraftError.value = "";
  }

  function applyBaIssueDraftError(ev: {
    userId: string;
    threadId: string;
    error: string;
  }) {
    if (!isMyEvent(ev.userId)) return;
    if (
      issueDraftThreadId.value &&
      ev.threadId !== issueDraftThreadId.value
    ) {
      return;
    }
    issueDraftError.value = ev.error;
    issueDrafting.value = false;
    issueDraftLabel.value = "";
  }

  async function bootstrap() {
    loading.value = true;
    try {
      // Keep in-flight chat when remounting layout (Chat ↔ Work).
      const keepThreadId = activeThreadId.value;
      const keepStreaming = streaming.value;
      const keepMessages = keepStreaming ? messages.value.slice() : null;
      const keepStreamingMessageId = streamingMessageId.value;
      const keepProgress = keepStreaming ? progress.value.slice() : null;

      await loadProjects();
      await loadThreads();

      if (
        keepThreadId &&
        threads.value.some((t) => t.id === keepThreadId)
      ) {
        activeThreadId.value = keepThreadId;
        if (keepStreaming && keepMessages) {
          messages.value = keepMessages;
          streaming.value = true;
          streamingMessageId.value = keepStreamingMessageId;
          if (keepProgress) {
            progress.value = keepProgress;
            progressVisible.value = keepProgress.length > 0;
          }
        } else if (!keepStreaming) {
          await selectThread(keepThreadId);
        }
      }
    } finally {
      loading.value = false;
    }
  }

  /** After SSE wake — refresh open thread unless a stream is in flight. */
  async function resyncRealtime() {
    const id = activeThreadId.value;
    if (!id || streaming.value) return;
    try {
      await selectThread(id);
    } catch {
      /* ignore */
    }
  }

  return {
    projects,
    selectedProjectId,
    selectedProject,
    threads,
    activeThreadId,
    activeThread,
    messages,
    streaming,
    streamingMessageId,
    stopBusy,
    loading,
    errorText,
    progress,
    progressVisible,
    analysisMode,
    setAnalysisMode,
    features,
    featuresLoaded,
    featureVisible,
    featureLabel,
    currentProgressLabel,
    progressPct,
    projectReady,
    bootstrap,
    resyncRealtime,
    reset,
    loadProjects,
    loadThreads,
    selectProject,
    selectThread,
    newChat,
    deleteThread,
    sendMessage,
    stop,
    applyBaMessage,
    applyBaDelta,
    applyBaDone,
    applyBaError,
    applyBaProgress,
    issueDrafting,
    issueDraftThreadId,
    issueDraftLabel,
    issueDraftError,
    issueDraftResult,
    beginIssueDraft,
    clearIssueDraft,
    applyBaIssueDraftProgress,
    applyBaIssueDraftDone,
    applyBaIssueDraftError,
  };
});
