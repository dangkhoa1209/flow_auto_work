import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";

export type BaProject = {
  id: string;
  slug: string;
  displayName: string;
  gitlabPath: string;
  cloneStatus: string;
  cloneError: string | null;
  ready?: boolean;
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

export const useBaChatStore = defineStore("baChat", () => {
  const session = useSessionStore();

  const projects = ref<BaProject[]>([]);
  const selectedProjectId = ref<string | null>(
    localStorage.getItem("flow_ba_project_id"),
  );
  const threads = ref<BaThread[]>([]);
  const activeThreadId = ref<string | null>(null);
  const messages = ref<BaMessage[]>([]);
  const streaming = ref(false);
  const streamingMessageId = ref<string | null>(null);
  const loading = ref(false);
  const errorText = ref("");

  const selectedProject = computed(() =>
    projects.value.find((p) => p.id === selectedProjectId.value) || null,
  );

  const activeThread = computed(() =>
    threads.value.find((t) => t.id === activeThreadId.value) || null,
  );

  const projectReady = computed(() =>
    Boolean(selectedProject.value?.ready),
  );

  function persistProjectId(id: string | null) {
    selectedProjectId.value = id;
    if (id) localStorage.setItem("flow_ba_project_id", id);
    else localStorage.removeItem("flow_ba_project_id");
  }

  async function loadProjects() {
    const data = await api<{ projects?: BaProject[] }>(API.ba.projects);
    projects.value = data.projects || [];
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
      return;
    }
    const qs = `?baProjectId=${encodeURIComponent(selectedProjectId.value)}`;
    const data = await api<{ threads?: BaThread[] }>(`${API.ba.threads}${qs}`);
    threads.value = data.threads || [];
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
    try {
      const data = await api<{ message?: BaMessage }>(API.ba.messages(threadId), {
        method: "POST",
        body: JSON.stringify({ content: text }),
      });
      if (data.message) {
        const exists = messages.value.some((m) => m.id === data.message!.id);
        if (!exists) messages.value.push(data.message);
      }
    } catch (e) {
      streaming.value = false;
      errorText.value = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  function applyBaMessage(ev: {
    userId: string;
    threadId: string;
    message: BaMessage;
  }) {
    const uid = (session.me?.id || session.me?.gitlabUsername || "").toLowerCase();
    if (ev.userId && uid && ev.userId !== uid) return;
    if (ev.threadId !== activeThreadId.value) {
      // Refresh thread list titles when idle
      void loadThreads();
      return;
    }
    const idx = messages.value.findIndex((m) => m.id === ev.message.id);
    if (idx >= 0) messages.value[idx] = ev.message;
    else messages.value.push(ev.message);
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
    const uid = (session.me?.id || session.me?.gitlabUsername || "").toLowerCase();
    if (ev.userId && uid && ev.userId !== uid) return;
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
    const uid = (session.me?.id || session.me?.gitlabUsername || "").toLowerCase();
    if (ev.userId && uid && ev.userId !== uid) return;
    if (ev.threadId === activeThreadId.value) {
      const idx = messages.value.findIndex((m) => m.id === ev.messageId);
      if (idx >= 0) {
        messages.value[idx] = {
          ...messages.value[idx],
          content: ev.content,
        };
      }
    }
    streaming.value = false;
    streamingMessageId.value = null;
    void loadThreads();
  }

  function applyBaError(ev: {
    userId: string;
    threadId: string;
    messageId?: string;
    error: string;
  }) {
    const uid = (session.me?.id || session.me?.gitlabUsername || "").toLowerCase();
    if (ev.userId && uid && ev.userId !== uid) return;
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

  async function bootstrap() {
    loading.value = true;
    try {
      await loadProjects();
      await loadThreads();
    } finally {
      loading.value = false;
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
    loading,
    errorText,
    projectReady,
    bootstrap,
    loadProjects,
    loadThreads,
    selectProject,
    selectThread,
    newChat,
    deleteThread,
    sendMessage,
    applyBaMessage,
    applyBaDelta,
    applyBaDone,
    applyBaError,
  };
});
