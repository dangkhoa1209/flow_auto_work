import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { API } from "@/api/endpoints";
import { api } from "@/api/client";
import { jobApi } from "@/api/jobApi";
import { useSettingsStore } from "./settings";

export type Task = {
  issueIid: number;
  title: string;
  labels?: string[];
  url?: string;
  skip?: boolean;
  milestone?: { title?: string } | null;
};

export type Job = {
  id: string;
  status: string;
  kind?: "issue" | "adhoc";
  issue?: {
    issueIid?: number;
    title?: string;
    url?: string;
    action?: string;
    labels?: string[];
    milestone?: { title?: string } | null;
  };
  runCount?: number;
  agentId?: string;
  commitSha?: string;
  commitShas?: string[];
  error?: string;
  summary?: string;
  branch?: string;
  workBranch?: string;
  baseBranch?: string;
  requireDocsFirst?: boolean;
  lastQuestion?: string;
  devNotes?: string;
  techLeadNotes?: string;
  contextQuality?: {
    level: "good" | "searchable" | "bad" | string;
    assessedAt?: string;
    reason?: string;
    anchors?: string[];
    fileHints?: string[];
  };
};

export function isAdhocJob(job: Job | null | undefined): boolean {
  if (!job) return false;
  if (job.kind === "adhoc") return true;
  return (
    (job.issue?.issueIid ?? 0) <= 0 || job.issue?.action === "adhoc"
  );
}

export type TaskNote = {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  system: boolean;
};

export type RelatedIssue = {
  iid: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  linkType?: string;
  source: "issue_links" | "mention" | "task_list" | string;
  assignees?: string[];
};

export type TaskDetail = {
  projectId?: number;
  issueIid: number;
  title: string;
  description?: string;
  state?: string;
  url?: string;
  labels?: string[];
  assignees?: Array<{ username: string; name?: string }>;
  milestone?: { title?: string } | null;
  taskCompletion?: { count: number; completedCount: number };
  notes?: TaskNote[];
  related?: RelatedIssue[];
};

export const useWorkStore = defineStore("work", () => {
  const tasks = ref<Task[]>([]);
  const jobs = ref<Job[]>([]);
  const selectedTaskIid = ref<number | null>(null);
  const selectedJobId = ref<string | null>(null);
  const currentJob = ref<Job | null>(null);
  const taskDetail = ref<TaskDetail | null>(null);
  const chat = ref<
    Array<{
      role: string;
      body: string;
      kind?: string;
      createdAt?: string;
      pending?: boolean;
    }>
  >([]);
  /** Agent đang suy nghĩ — UI typing indicator */
  const agentTyping = ref(false);
  const progressLines = ref<
    Array<{ id: number; at: string; kind: string; text: string }>
  >([]);
  const progressAfterId = ref(0);
  const progressLive = ref(false);
  const members = ref<Array<{ username: string; name?: string }>>([]);
  const labels = ref<string[]>([]);
  const loading = ref(false);
  const jobLoading = ref(false);
  const statusText = ref("");

  const selectedJob = computed(
    () => jobs.value.find((j) => j.id === selectedJobId.value) || currentJob.value,
  );

  async function loadTasks() {
    const data = await api<{ tasks: Task[] }>(API.tasks.list);
    tasks.value = data.tasks || [];
  }

  async function loadJobs() {
    const prevStatus = currentJob.value?.status;
    const data = await jobApi.list({ limit: 40 });
    jobs.value = (data.jobs || []) as Job[];
    // Keep currentJob.status in sync so Progress polling knows job is live
    if (selectedJobId.value) {
      const j = jobs.value.find((x) => x.id === selectedJobId.value);
      if (j) {
        const wasBusy = isJobStatusBusy(prevStatus);
        currentJob.value = currentJob.value
          ? { ...currentJob.value, ...j }
          : j;
        // Job vừa xong → chỉ refresh chat (không đụng issue / không spinner)
        if (wasBusy && !isJobStatusBusy(j.status) && !agentTyping.value) {
          void refreshJobChat(selectedJobId.value).catch(() => undefined);
        }
      }
    }
  }

  async function loadMeta() {
    const [m, l] = await Promise.all([
      api<{ members: Array<{ username: string; name?: string }> }>(
        "/api/meta/members",
      ).catch(() => ({ members: [] })),
      api<{ labels: Array<string | { name?: string }> }>("/api/meta/labels").catch(
        () => ({ labels: [] }),
      ),
    ]);
    members.value = m.members || [];
    labels.value = (l.labels || [])
      .map((x) => (typeof x === "string" ? x : x?.name)?.trim())
      .filter((n): n is string => Boolean(n));
  }

  async function loadStatus() {
    const s = await api<{
      queueLength?: number;
      currentJobId?: string | null;
      queue?: {
        queued?: number;
        currentJobId?: string | null;
      };
    }>("/api/status");
    applyStatusSnapshot({
      currentJobId: s.currentJobId ?? s.queue?.currentJobId ?? null,
      queueLength: s.queueLength ?? s.queue?.queued ?? 0,
    });
  }

  function applyStatusSnapshot(s: {
    currentJobId: string | null;
    queueLength: number;
  }) {
    statusText.value = s.currentJobId
      ? `Running ${s.currentJobId}`
      : s.queueLength
        ? `Queue ${s.queueLength}`
        : "Idle";
  }

  /** Debounced jobs list refresh (SSE can fire often during a run). */
  let jobsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleLoadJobs() {
    if (jobsRefreshTimer) clearTimeout(jobsRefreshTimer);
    jobsRefreshTimer = setTimeout(() => {
      void loadJobs().catch(() => undefined);
    }, 400);
  }

  function applyRealtimeProgress(ev: {
    jobId: string;
    line: { id: number; at: string; kind: string; text: string };
    live: boolean;
  }) {
    if (selectedJobId.value !== ev.jobId) return;
    progressLive.value = ev.live;
    if (!ev.line?.id) {
      if (!ev.live) progressLive.value = false;
      return;
    }
    const idx = progressLines.value.findIndex((l) => l.id === ev.line.id);
    if (idx >= 0) {
      const next = [...progressLines.value];
      next[idx] = ev.line;
      progressLines.value = next;
    } else {
      progressLines.value = [...progressLines.value, ev.line];
    }
    progressAfterId.value = Math.max(progressAfterId.value, ev.line.id);
  }

  function applyRealtimeJob(ev: { jobId: string; status?: string }) {
    if (!ev.status) return;
    const j = jobs.value.find((x) => x.id === ev.jobId);
    if (j) {
      const wasBusy = isJobStatusBusy(j.status);
      j.status = ev.status;
      if (currentJob.value?.id === ev.jobId) {
        const prev = currentJob.value.status;
        currentJob.value = { ...currentJob.value, status: ev.status };
        if (
          isJobStatusBusy(prev) &&
          !isJobStatusBusy(ev.status) &&
          !agentTyping.value
        ) {
          void refreshJobChat(ev.jobId).catch(() => undefined);
        }
      } else if (
        wasBusy &&
        !isJobStatusBusy(ev.status) &&
        selectedJobId.value === ev.jobId &&
        !agentTyping.value
      ) {
        void refreshJobChat(ev.jobId).catch(() => undefined);
      }
    } else {
      scheduleLoadJobs();
    }
  }

  /** Soft refresh: job + chat only — không clear UI, không gọi lại GitLab issue. */
  async function refreshJobChat(id?: string | null) {
    const jobId = id || selectedJobId.value;
    if (!jobId) return;
    const detail = await api<{
      job: Job;
      chat: typeof chat.value;
    }>(`/api/jobs/${jobId}`);
    if (selectedJobId.value !== jobId) return;
    currentJob.value = detail.job;
    const server = detail.chat || [];
    if (agentTyping.value) {
      // Giữ tin user vừa gửi (optimistic) nếu server chưa kịp / bị race SSE
      chat.value = mergePendingChat(server, chat.value);
    } else {
      chat.value = server;
    }
  }

  function mergePendingChat(
    server: typeof chat.value,
    local: typeof chat.value,
  ): typeof chat.value {
    const keys = new Set(
      server.map((m) => `${m.role}\0${String(m.body || "").trim()}`),
    );
    const pending = local.filter((m) => {
      if (!m.pending) return false;
      return !keys.has(`${m.role}\0${String(m.body || "").trim()}`);
    });
    return pending.length ? [...server, ...pending] : server;
  }

  async function loadIssueForJob(job: Job) {
    const iid = job?.issue?.issueIid;
    if (iid && iid > 0 && !isAdhocJob(job)) {
      selectedTaskIid.value = iid;
      // Giữ issue đang xem nếu cùng iid — tránh GitLab fetch thừa
      if (taskDetail.value?.issueIid === iid) return;
      const res = await api<{ detail: TaskDetail }>(`/api/tasks/${iid}`);
      if (selectedTaskIid.value !== iid) return;
      taskDetail.value = res.detail;
    } else {
      selectedTaskIid.value = null;
      taskDetail.value = null;
    }
  }

  async function selectJob(id: string) {
    const switching = selectedJobId.value !== id;
    selectedJobId.value = id;
    if (switching) {
      progressAfterId.value = 0;
      progressLines.value = [];
      chat.value = [];
      agentTyping.value = false;
    }
    // Spinner chỉ khi đổi job — re-select / sau Run không flash issue+chat
    jobLoading.value = switching;
    try {
      const detail = await api<{
        job: Job;
        chat: typeof chat.value;
        pendingQuestion?: string;
      }>(`/api/jobs/${id}`);
      // Stale response if user clicked another job meanwhile
      if (selectedJobId.value !== id) return;
      currentJob.value = detail.job;
      chat.value = detail.chat || [];
      await loadIssueForJob(detail.job);
      if (selectedJobId.value !== id) return;
      await pollProgress(switching || progressLines.value.length === 0);
    } finally {
      if (selectedJobId.value === id) jobLoading.value = false;
    }
  }

  /** Load GitLab issue detail only (no job ensure). */
  async function fetchTaskDetail(iid: number) {
    const res = await api<{ detail: TaskDetail }>(`/api/tasks/${iid}`);
    return res.detail;
  }

  /** Load GitLab issue detail + ensure job (like old UI selectTask) */
  async function selectTask(iid: number) {
    selectedTaskIid.value = iid;
    jobLoading.value = true;
    try {
      const [res, ensured] = await Promise.all([
        api<{ detail: TaskDetail }>(`/api/tasks/${iid}`),
        api<{ job: Job }>("/api/jobs/ensure", {
          method: "POST",
          body: JSON.stringify({ issueIid: iid }),
        }),
      ]);
      if (selectedTaskIid.value !== iid) return;
      taskDetail.value = res.detail;
      currentJob.value = ensured.job;
      selectedJobId.value = ensured.job?.id || selectedJobId.value;
      await loadJobs();
      // Load chat/progress for ensured job without clearing taskDetail
      if (ensured.job?.id) {
        const jobDetail = await api<{
          job: Job;
          chat: typeof chat.value;
        }>(`/api/jobs/${ensured.job.id}`);
        if (selectedTaskIid.value !== iid) return;
        currentJob.value = jobDetail.job;
        chat.value = jobDetail.chat || [];
        progressAfterId.value = 0;
        progressLines.value = [];
        await pollProgress(true);
      }
    } finally {
      if (selectedTaskIid.value === iid) jobLoading.value = false;
    }
  }

  async function saveDevNotes(opts: {
    devNotes: string;
    requireDocsFirst?: boolean;
  }) {
    const notes = opts.devNotes.trim();
    if (selectedJobId.value) {
      const res = await api<{ job: Job }>(
        `/api/jobs/${selectedJobId.value}/dev-notes`,
        {
          method: "PUT",
          body: JSON.stringify({
            devNotes: notes,
            requireDocsFirst: opts.requireDocsFirst,
          }),
        },
      );
      currentJob.value = res.job;
      await loadJobs();
      return res.job;
    }
    if (!selectedTaskIid.value) {
      throw new Error("Chưa chọn task/job");
    }
    const res = await api<{ job: Job }>("/api/jobs/ensure", {
      method: "POST",
      body: JSON.stringify({
        issueIid: selectedTaskIid.value,
        devNotes: notes,
        requireDocsFirst: opts.requireDocsFirst,
      }),
    });
    currentJob.value = res.job;
    selectedJobId.value = res.job.id;
    await loadJobs();
    return res.job;
  }

  async function pollProgress(reset = false) {
    if (!selectedJobId.value) return;
    if (reset) progressAfterId.value = 0;
    const q = reset ? "" : `?after=${progressAfterId.value}`;
    const data = await api<{
      lines: typeof progressLines.value;
      latestId: number;
      live: boolean;
      status?: string;
    }>(`/api/jobs/${selectedJobId.value}/progress${q}`);
    if (reset) progressLines.value = [];
    if (data.lines?.length) {
      progressLines.value = [...progressLines.value, ...data.lines];
    }
    progressAfterId.value = data.latestId || progressAfterId.value;
    progressLive.value = Boolean(data.live);
    if (data.status && currentJob.value?.id === selectedJobId.value) {
      const wasBusy = isJobStatusBusy(currentJob.value.status);
      currentJob.value = { ...currentJob.value, status: data.status };
      if (wasBusy && !isJobStatusBusy(data.status) && !agentTyping.value) {
        void refreshJobChat(selectedJobId.value).catch(() => undefined);
      }
    }
  }

  /** Call when starting Run / Gửi so Progress polls immediately */
  function watchProgress() {
    progressLive.value = true;
    // Không fake status=running — SSE status cũ sẽ bị hiểu nhầm busy→idle và xóa chat
  }

  function isJobStatusBusy(st?: string) {
    return ["queued", "running", "awaiting_clarification"].includes(st || "");
  }

  /** Whether UI should keep polling progress for the selected job */
  function shouldPollProgress() {
    if (!selectedJobId.value) return false;
    if (progressLive.value) return true;
    const j =
      jobs.value.find((x) => x.id === selectedJobId.value) || currentJob.value;
    return isJobStatusBusy(j?.status);
  }

  async function startJobs(opts: {
    mode: "selected" | "all" | "auto";
    issueIids?: number[];
    issueIid?: number;
    devNotes?: string;
    requireDocsFirst?: boolean;
  }) {
    const settings = useSettingsStore();
    watchProgress();
    const res = await api<{ jobId?: string; enqueued?: number }>(
      "/api/jobs/start",
      {
        method: "POST",
        body: JSON.stringify({
          ...opts,
          completion: settings.completionPayload(),
        }),
      },
    );
    await loadJobs();
    if (res.jobId) {
      if (selectedJobId.value === res.jobId) {
        progressAfterId.value = 0;
        progressLines.value = [];
        await refreshJobChat(res.jobId);
        await pollProgress(true);
      } else {
        await selectJob(res.jobId);
      }
    }
    return res;
  }

  function appendLocalChat(msg: {
    role: string;
    body: string;
    kind?: string;
  }) {
    chat.value = [
      ...chat.value,
      {
        role: msg.role,
        body: msg.body,
        kind: msg.kind,
        createdAt: new Date().toISOString(),
        pending: true,
      },
    ];
  }

  async function sendContinue(message: string) {
    if (!selectedJobId.value) throw new Error("Chưa chọn job");
    appendLocalChat({ role: "user", body: message, kind: "qa" });
    agentTyping.value = true;
    watchProgress();
    try {
      await api(`/api/jobs/${selectedJobId.value}/continue`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      await refreshJobChat(selectedJobId.value);
    } finally {
      agentTyping.value = false;
    }
  }

  async function sendAsk(question: string) {
    if (!selectedJobId.value) throw new Error("Chưa chọn job");
    appendLocalChat({ role: "user", body: question, kind: "qa" });
    agentTyping.value = true;
    watchProgress();
    try {
      await api(`/api/jobs/${selectedJobId.value}/ask`, {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      await refreshJobChat(selectedJobId.value);
    } finally {
      agentTyping.value = false;
    }
  }

  async function sendClarify(answer: string) {
    if (!selectedJobId.value) throw new Error("Chưa chọn job");
    await api(`/api/jobs/${selectedJobId.value}/clarify`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
  }

  async function killJob(jobId: string) {
    await jobApi.kill(jobId);
    agentTyping.value = false;
    await loadJobs();
  }

  /** PM approves docs-first phase → enqueue code. */
  async function approveDocs(jobId: string) {
    const res = await jobApi.approveDocs(jobId);
    if (selectedJobId.value === jobId && res.job) {
      currentJob.value = { ...currentJob.value, ...(res.job as Job) };
    }
    await loadJobs();
    return res;
  }

  /** Stop if busy + clear agentId → next Run/chat opens a fresh Cursor window. */
  async function resetAgentWindow(jobId: string) {
    const res = await api<{
      ok: boolean;
      killed: boolean;
      previousAgentId?: string | null;
      job: Job;
    }>(`/api/jobs/${jobId}/reset-window`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (selectedJobId.value === jobId && res.job) {
      currentJob.value = { ...currentJob.value, ...res.job, agentId: undefined };
    }
    await loadJobs();
    await refreshJobChat(jobId);
    return res;
  }

  async function setJobStatus(
    jobId: string,
    status: string,
    opts?: { force?: boolean },
  ) {
    const res = await api<{ job: Job }>(`/api/jobs/${jobId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, force: opts?.force === true }),
    });
    await loadJobs();
    if (selectedJobId.value === jobId && res.job) {
      currentJob.value = res.job;
    }
    return res.job;
  }

  async function deleteJob(jobId: string, opts?: { force?: boolean }) {
    const q = opts?.force ? "?force=1" : "";
    await api(`/api/jobs/${jobId}${q}`, { method: "DELETE" });
    if (selectedJobId.value === jobId) {
      selectedJobId.value = null;
      currentJob.value = null;
      chat.value = [];
      progressLines.value = [];
      taskDetail.value = null;
    }
    await loadJobs();
  }

  async function createAdhocSession(opts: {
    title: string;
    message?: string;
    labels?: string[];
  }) {
    const res = await api<{ job: Job; started?: boolean }>("/api/jobs/adhoc", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    await loadJobs();
    if (res.job?.id) await selectJob(res.job.id);
    return res;
  }

  async function fetchIssueDraft(jobId: string) {
    return api<{
      title: string;
      description: string;
      labels: string[];
      branch: string | null;
      commitSha: string | null;
      summary: string | null;
    }>(`/api/jobs/${jobId}/issue-draft`);
  }

  async function createGitlabIssue(
    jobId: string,
    opts: { title: string; description: string; labels?: string[] },
  ) {
    const res = await api<{ job: Job; issueUrl?: string }>(
      `/api/jobs/${jobId}/create-issue`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      },
    );
    await loadJobs();
    if (res.job?.id) await selectJob(res.job.id);
    return res;
  }

  async function refreshAll() {
    loading.value = true;
    try {
      await Promise.all([loadTasks(), loadJobs(), loadMeta(), loadStatus()]);
    } finally {
      loading.value = false;
    }
  }

  return {
    tasks,
    jobs,
    selectedTaskIid,
    selectedJobId,
    currentJob,
    selectedJob,
    taskDetail,
    chat,
    agentTyping,
    progressLines,
    progressLive,
    members,
    labels,
    loading,
    jobLoading,
    statusText,
    loadTasks,
    loadJobs,
    loadMeta,
    loadStatus,
    applyStatusSnapshot,
    scheduleLoadJobs,
    applyRealtimeProgress,
    applyRealtimeJob,
    selectJob,
    selectTask,
    refreshJobChat,
    fetchTaskDetail,
    saveDevNotes,
    pollProgress,
    watchProgress,
    shouldPollProgress,
    startJobs,
    sendContinue,
    sendAsk,
    sendClarify,
    killJob,
    approveDocs,
    resetAgentWindow,
    setJobStatus,
    deleteJob,
    createAdhocSession,
    fetchIssueDraft,
    createGitlabIssue,
    refreshAll,
  };
});
