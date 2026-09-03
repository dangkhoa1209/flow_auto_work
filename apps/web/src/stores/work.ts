import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { API } from "@/api/endpoints";
import { api } from "@/api/client";
import { getProjectId } from "@/api/tokenStorage";
import { jobApi } from "@/api/jobApi";
import { useSettingsStore } from "./settings";
import type { GitlabLabelColor } from "@/utils/gitlabLabel";

const MILESTONE_FILTER_KEY = "faw.milestoneFilter";
const LABEL_FILTER_KEY = "faw.labelFilter";
const PROGRESS_POLL_MIN_MS = 1500;
const PROGRESS_POLL_MAX_MS = 20_000;

function persistedFilterKey(prefix: string, projectId: string): string {
  return `${prefix}:${projectId}`;
}

function readPersistedFilter(prefix: string, projectId: string | null): string {
  if (!projectId) return "all";
  try {
    const v = localStorage.getItem(persistedFilterKey(prefix, projectId));
    return (v || "all").trim() || "all";
  } catch {
    return "all";
  }
}

function writePersistedFilter(
  prefix: string,
  projectId: string | null,
  value: string,
): void {
  if (!projectId) return;
  try {
    localStorage.setItem(
      persistedFilterKey(prefix, projectId),
      value || "all",
    );
  } catch {
    /* ignore quota / private mode */
  }
}

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
  commitMode?: "manual" | "auto";
  hasPendingChanges?: boolean;
  mrUrl?: string;
  mrIid?: number;
  error?: string;
  summary?: string;
  branch?: string;
  workBranch?: string;
  baseBranch?: string;
  requireDocsFirst?: boolean;
  planFirst?: boolean;
  planSummary?: string;
  lastQuestion?: string;
  devNotes?: string;
  contextQuality?: {
    level: "good" | "searchable" | "bad" | string;
    assessedAt?: string;
    reason?: string;
    anchors?: string[];
    fileHints?: string[];
  };
  /** Public Google auth metadata (tokens never sent to UI) */
  googleAuth?: {
    email?: string;
    scopes?: string[];
    sheetIds?: string[];
    authorizedAt?: string;
    revokedAt?: string;
  };
  pendingGoogleSheetUrls?: string[];
  /** Opt-in spreadsheet IDs to read on Run (default empty = skip) */
  googleSheetsIncludeIds?: string[];
  figmaIncludeKeys?: string[];
  pendingFigmaUrls?: string[];
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
  /** Agent is thinking — UI typing indicator */
  const agentTyping = ref(false);
  const progressLines = ref<
    Array<{ id: number; at: string; kind: string; text: string }>
  >([]);
  const progressAfterId = ref(0);
  const progressLive = ref(false);
  let progressPollDelayMs = PROGRESS_POLL_MIN_MS;
  let progressPollTimer: ReturnType<typeof setTimeout> | undefined;
  const members = ref<Array<{ username: string; name?: string }>>([]);
  const labels = ref<string[]>([]);
  /** GitLab label name → color (matches GitLab UI) */
  const labelCatalog = ref<Record<string, GitlabLabelColor>>({});
  /** GitLab project milestone titles (stable across task refresh) */
  const projectMilestones = ref<string[]>([]);
  /** Persisted per active project — survives F5 */
  const milestoneFilter = ref<string>(
    readPersistedFilter(MILESTONE_FILTER_KEY, getProjectId()),
  );
  const labelFilter = ref<string>(
    readPersistedFilter(LABEL_FILTER_KEY, getProjectId()),
  );
  const loading = ref(false);
  const jobLoading = ref(false);
  const statusText = ref("");
  const runningJobIds = ref<string[]>([]);
  const queueLength = ref(0);
  const killAllBusy = ref(false);

  const activeJobCount = computed(() => {
    const busyInList = jobs.value.filter((j) =>
      ["queued", "running"].includes(j.status || ""),
    ).length;
    const fromStatus = runningJobIds.value.length + queueLength.value;
    return Math.max(busyInList, fromStatus);
  });

  const canKillAll = computed(() => activeJobCount.value >= 1);

  watch(milestoneFilter, (v) => {
    writePersistedFilter(MILESTONE_FILTER_KEY, getProjectId(), v);
  });

  watch(labelFilter, (v) => {
    writePersistedFilter(LABEL_FILTER_KEY, getProjectId(), v);
  });

  function hydrateTaskFilters() {
    const pid = getProjectId();
    milestoneFilter.value = readPersistedFilter(MILESTONE_FILTER_KEY, pid);
    labelFilter.value = readPersistedFilter(LABEL_FILTER_KEY, pid);
  }

  function setMilestoneFilter(value: string) {
    milestoneFilter.value = (value || "all").trim() || "all";
  }

  function setLabelFilter(value: string) {
    labelFilter.value = (value || "all").trim() || "all";
  }

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
        // Job just finished → drop typing + refresh chat (SSE / poll)
        if (wasBusy && !isJobStatusBusy(j.status)) {
          onSelectedJobBecameIdle(selectedJobId.value);
        } else if (isJobStatusBusy(j.status) && !progressLive.value) {
          // Mid-run after reload — show thinking again + keep progress catch-up
          agentTyping.value = true;
          watchProgress();
        }
      } else {
        // Job not in this project's list (e.g. switched project) — clear selection
        stopProgressPolling();
        selectedJobId.value = null;
        currentJob.value = null;
        chat.value = [];
        progressLines.value = [];
        progressLive.value = false;
        taskDetail.value = null;
        agentTyping.value = false;
      }
    }
  }

  async function loadMeta() {
    hydrateTaskFilters();
    const [m, l] = await Promise.all([
      api<{ members: Array<{ username: string; name?: string }> }>(
        API.meta.members,
      ).catch(() => ({ members: [] })),
      api<{
        labels: Array<
          | string
          | {
              name?: string;
              color?: string;
              textColor?: string;
              text_color?: string;
            }
        >;
      }>(API.meta.labels).catch(() => ({ labels: [] })),
    ]);
    members.value = m.members || [];
    const catalog: Record<string, GitlabLabelColor> = {};
    const names: string[] = [];
    for (const x of l.labels || []) {
      const name = (typeof x === "string" ? x : x?.name)?.trim();
      if (!name) continue;
      names.push(name);
      if (typeof x === "string") {
        catalog[name] = { name };
      } else {
        catalog[name] = {
          name,
          color: x.color,
          textColor: x.textColor || x.text_color,
        };
      }
    }
    labels.value = names;
    labelCatalog.value = catalog;
    projectMilestones.value = [];
  }

  async function loadStatus() {
    const s = await api<{
      queueLength?: number;
      currentJobId?: string | null;
      currentJobIds?: string[];
      queue?: {
        queued?: number;
        currentJobId?: string | null;
        currentJobIds?: string[];
      };
    }>("/api/status");
    applyStatusSnapshot({
      currentJobId: s.currentJobId ?? s.queue?.currentJobId ?? null,
      currentJobIds: s.currentJobIds ?? s.queue?.currentJobIds,
      queueLength: s.queueLength ?? s.queue?.queued ?? 0,
    });
  }

  function applyStatusSnapshot(s: {
    currentJobId: string | null;
    currentJobIds?: string[];
    queueLength: number;
  }) {
    const runningIds = s.currentJobIds?.length
      ? s.currentJobIds
      : s.currentJobId
        ? [s.currentJobId]
        : [];
    runningJobIds.value = runningIds;
    queueLength.value = s.queueLength ?? 0;
    statusText.value =
      runningIds.length > 1
        ? `Running ${runningIds.length} jobs`
        : runningIds.length === 1
          ? `Running ${runningIds[0]}`
          : s.queueLength
            ? `Queue ${s.queueLength}`
            : "Idle";

    // If open job is no longer in the running set, don't leave UI stuck on
    // "Waiting for Cursor stream…" when SSE progress end was dropped.
    const openId = selectedJobId.value;
    if (
      openId &&
      (progressLive.value || agentTyping.value) &&
      !runningIds.includes(openId) &&
      !s.queueLength
    ) {
      const st =
        (jobs.value.find((j) => j.id === openId) || currentJob.value)?.status;
      if (!isJobStatusBusy(st)) {
        onSelectedJobBecameIdle(openId);
      } else {
        // Status may be stale in memory — arm debounce poll to reconcile
        scheduleProgressPollDebounce();
      }
    }
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
    // id 0 = end-of-stream marker from untrackRun — do not treat as a real line
    if (!ev.line || !(ev.line.id > 0)) {
      if (!ev.live) {
        progressLive.value = false;
        stopProgressPolling();
      }
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
    // SSE đang chảy → lùi poll safety-net; reset backoff vì stream còn sống
    if (ev.live) {
      progressPollDelayMs = PROGRESS_POLL_MIN_MS;
      scheduleProgressPollDebounce();
    }
  }

  function applyRealtimeJob(ev: { jobId: string; status?: string }) {
    if (!ev.status) return;
    const j = jobs.value.find((x) => x.id === ev.jobId);
    const touchesOpen =
      selectedJobId.value === ev.jobId || currentJob.value?.id === ev.jobId;

    if (j) {
      const wasBusy = isJobStatusBusy(j.status);
      const nowBusy = isJobStatusBusy(ev.status);
      j.status = ev.status;
      if (currentJob.value?.id === ev.jobId) {
        const prev = currentJob.value.status;
        if (prev !== ev.status) {
          currentJob.value = { ...currentJob.value, status: ev.status };
        }
        if (isJobStatusBusy(prev) && !nowBusy) {
          onSelectedJobBecameIdle(ev.jobId);
        } else if (!isJobStatusBusy(prev) && nowBusy) {
          agentTyping.value = true;
          watchProgress();
        }
      } else if (wasBusy && !nowBusy && selectedJobId.value === ev.jobId) {
        onSelectedJobBecameIdle(ev.jobId);
      } else if (!wasBusy && nowBusy && selectedJobId.value === ev.jobId) {
        agentTyping.value = true;
        watchProgress();
      }
      return;
    }

    // Job not in list yet — still update open console if this is the selected job
    if (touchesOpen && currentJob.value?.id === ev.jobId) {
      const prev = currentJob.value.status;
      const nowBusy = isJobStatusBusy(ev.status);
      if (prev !== ev.status) {
        currentJob.value = { ...currentJob.value, status: ev.status };
      }
      if (isJobStatusBusy(prev) && !nowBusy) {
        onSelectedJobBecameIdle(ev.jobId);
      } else if (!isJobStatusBusy(prev) && nowBusy) {
        agentTyping.value = true;
        watchProgress();
      }
    }
    scheduleLoadJobs();
  }

  /** SSE chat event — append message to the open console without refetch. */
  function applyRealtimeChat(ev: {
    jobId: string;
    message?: {
      role: string;
      kind?: string;
      body: string;
      createdAt?: string;
    };
  }) {
    if (selectedJobId.value !== ev.jobId) return;
    const msg = ev.message;
    if (!msg?.body?.trim()) {
      // No payload — fall back to a soft refresh
      void refreshJobChat(ev.jobId).catch(() => undefined);
      return;
    }
    const bodyKey = msg.body.trim();
    // Drop matching optimistic pending message; skip if already present
    const rest = chat.value.filter(
      (m) =>
        !(m.pending && m.role === msg.role && (m.body || "").trim() === bodyKey),
    );
    const dup = rest.some(
      (m) =>
        m.role === msg.role &&
        (m.body || "").trim() === bodyKey &&
        m.createdAt === msg.createdAt,
    );
    if (dup) {
      chat.value = rest;
      return;
    }
    chat.value = [
      ...rest,
      {
        role: msg.role,
        kind: msg.kind,
        body: msg.body,
        createdAt: msg.createdAt,
      },
    ];
  }

  /** Agent finished (Send/Ask/Run) — drop typing bubble and pull final chat via realtime path. */
  function onSelectedJobBecameIdle(jobId: string) {
    if (selectedJobId.value !== jobId) return;
    agentTyping.value = false;
    progressLive.value = false;
    stopProgressPolling();
    void refreshJobChat(jobId).catch(() => undefined);
    void pollProgress(false).catch(() => undefined);
  }

  /** Soft refresh: job + chat only — does not clear UI or re-fetch GitLab issue. */
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
      // Keep optimistic user message if server is slow / SSE race
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
      // Keep current issue if same iid — avoid redundant GitLab fetch
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
    // Spinner only when switching jobs — re-select / post-Run does not flash issue+chat
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
      agentTyping.value = isJobStatusBusy(detail.job.status);
      if (agentTyping.value) watchProgress();
      await loadIssueForJob(detail.job);
      if (selectedJobId.value !== id) return;
      await pollProgress(switching || progressLines.value.length === 0);
      if (selectedJobId.value === id && isJobStatusBusy(currentJob.value?.status)) {
        watchProgress();
      }
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
    planFirst?: boolean;
  }) {
    // Do not trim here — preserve draft whitespace; server clears all-blank only
    const notes = opts.devNotes;
    if (selectedJobId.value) {
      const jobId = selectedJobId.value;
      const res = await api<{ job: Job }>(
        `/api/jobs/${jobId}/dev-notes`,
        {
          method: "PUT",
          body: JSON.stringify({
            devNotes: notes,
            requireDocsFirst: opts.requireDocsFirst,
            planFirst: opts.planFirst,
          }),
        },
      );
      // Merge server job; keep local optimistic/fresher Dev Notes (textarea owns draft)
      if (selectedJobId.value === jobId && currentJob.value?.id === jobId) {
        const localNotes = currentJob.value.devNotes;
        currentJob.value = {
          ...res.job,
          devNotes:
            localNotes !== undefined ? localNotes : res.job.devNotes,
        };
      }
      await loadJobs();
      return res.job;
    }
    if (!selectedTaskIid.value) {
      throw new Error("No task/job selected");
    }
    const iid = selectedTaskIid.value;
    const res = await api<{ job: Job }>("/api/jobs/ensure", {
      method: "POST",
      body: JSON.stringify({
        issueIid: iid,
        devNotes: notes,
        requireDocsFirst: opts.requireDocsFirst,
        planFirst: opts.planFirst,
      }),
    });
    if (selectedTaskIid.value === iid) {
      currentJob.value = res.job;
      selectedJobId.value = res.job.id;
    }
    await loadJobs();
    return res.job;
  }

  async function pollProgress(reset = false) {
    if (!selectedJobId.value) return;
    const jobId = selectedJobId.value;
    if (reset) progressAfterId.value = 0;
    const q = reset ? "" : `?after=${progressAfterId.value}`;
    const data = await api<{
      lines: typeof progressLines.value;
      latestId: number;
      live: boolean;
      status?: string;
    }>(`/api/jobs/${jobId}/progress${q}`);
    if (selectedJobId.value !== jobId) return;
    if (reset) progressLines.value = [];
    if (data.lines?.length) {
      progressLines.value = [...progressLines.value, ...data.lines];
    }
    progressAfterId.value = data.latestId || progressAfterId.value;
    progressLive.value = Boolean(data.live);
    if (data.status && currentJob.value?.id === jobId) {
      const wasBusy = isJobStatusBusy(currentJob.value.status);
      if (currentJob.value.status !== data.status) {
        currentJob.value = { ...currentJob.value, status: data.status };
      }
      if (wasBusy && !isJobStatusBusy(data.status)) {
        onSelectedJobBecameIdle(jobId);
        return;
      }
    }
    if (!data.live && !isJobStatusBusy(data.status || currentJob.value?.status)) {
      agentTyping.value = false;
      progressLive.value = false;
      progressPollDelayMs = PROGRESS_POLL_MIN_MS;
      stopProgressPolling();
    } else if (shouldPollProgress()) {
      if (!data.lines?.length) {
        progressPollDelayMs = Math.min(
          PROGRESS_POLL_MAX_MS,
          Math.round(progressPollDelayMs * 2),
        );
      } else {
        progressPollDelayMs = PROGRESS_POLL_MIN_MS;
      }
      scheduleProgressPollDebounce();
    } else {
      stopProgressPolling();
    }
  }

  function stopProgressPolling() {
    if (!progressPollTimer) return;
    clearTimeout(progressPollTimer);
    progressPollTimer = undefined;
  }

  /**
   * Safety-net when SSE is silent. Backs off while /progress returns no
   * new lines (304); SSE progress / a new Run resets to 1.5s.
   */
  function scheduleProgressPollDebounce() {
    stopProgressPolling();
    if (!shouldPollProgress()) return;
    progressPollTimer = setTimeout(() => {
      progressPollTimer = undefined;
      if (!shouldPollProgress()) return;
      void pollProgress(false).catch(() => undefined);
    }, progressPollDelayMs);
  }

  /** Call when starting Run / Send — arm debounce; SSE will keep postponing poll. */
  function watchProgress() {
    progressLive.value = true;
    progressPollDelayMs = PROGRESS_POLL_MIN_MS;
    scheduleProgressPollDebounce();
    // Do not fake status=running — stale SSE status can be misread as busy→idle and wipe chat
  }

  function isJobStatusBusy(st?: string) {
    return ["queued", "running"].includes(st || "");
  }

  /** Selected job agent is busy — Send/Ask locked until idle. */
  function isSelectedJobAgentBusy() {
    if (agentTyping.value) return true;
    const j =
      jobs.value.find((x) => x.id === selectedJobId.value) || currentJob.value;
    return isJobStatusBusy(j?.status);
  }

  /** Whether UI should keep polling progress for the selected job */
  function shouldPollProgress() {
    if (!selectedJobId.value) return false;
    if (progressLive.value) return true;
    if (agentTyping.value) return true;
    const j =
      jobs.value.find((x) => x.id === selectedJobId.value) || currentJob.value;
    return isJobStatusBusy(j?.status);
  }

  async function startJobs(opts: {
    mode: "selected" | "all" | "auto";
    issueIids?: number[];
    issueIid?: number;
    jobIds?: string[];
    devNotes?: string;
    requireDocsFirst?: boolean;
    planFirst?: boolean;
  }) {
    const settings = useSettingsStore();
    watchProgress();
    const res = await api<{
      jobId?: string;
      jobIds?: string[];
      enqueued?: number;
      skipped?: number;
      missing?: number[];
      skipReasons?: Array<{ iid?: number; jobId?: string; reason: string }>;
    }>("/api/jobs/start", {
      method: "POST",
      body: JSON.stringify({
        ...opts,
        completion: settings.completionPayload(),
      }),
    });
    await loadJobs();
    const pickId = res.jobId || res.jobIds?.[0];
    if (pickId) {
      if (selectedJobId.value === pickId) {
        progressAfterId.value = 0;
        progressLines.value = [];
        await refreshJobChat(pickId);
        await pollProgress(true);
      } else {
        await selectJob(pickId);
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
    if (!selectedJobId.value) throw new Error("No job selected");
    if (isSelectedJobAgentBusy()) {
      throw new Error("Agent đang bận — đợi xong hoặc Force Stop rồi gửi lại");
    }
    appendLocalChat({ role: "user", body: message, kind: "qa" });
    agentTyping.value = true;
    watchProgress();
    try {
      const res = await api<{
        ok?: boolean;
        queued?: boolean;
        kind?: string;
        question?: string;
      }>(`/api/jobs/${selectedJobId.value}/continue`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      if (res?.kind === "bad_context") {
        agentTyping.value = false;
      } else if (currentJob.value?.id === selectedJobId.value) {
        // Optimistic: composer locked + thinking until SSE idle
        currentJob.value = { ...currentJob.value, status: "queued" };
      }
      await refreshJobChat(selectedJobId.value);
      await loadJobs().catch(() => undefined);
      await loadStatus().catch(() => undefined);
      return res;
    } catch (e) {
      agentTyping.value = false;
      throw e;
    }
  }

  async function sendAsk(question: string) {
    if (!selectedJobId.value) throw new Error("No job selected");
    if (isSelectedJobAgentBusy()) {
      throw new Error("Agent đang bận — đợi xong hoặc Force Stop rồi gửi lại");
    }
    appendLocalChat({ role: "user", body: question, kind: "qa" });
    agentTyping.value = true;
    watchProgress();
    try {
      const res = await api<{
        ok?: boolean;
        queued?: boolean;
        kind?: string;
      }>(`/api/jobs/${selectedJobId.value}/ask`, {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      if (currentJob.value?.id === selectedJobId.value) {
        currentJob.value = { ...currentJob.value, status: "queued" };
      }
      await refreshJobChat(selectedJobId.value);
      await loadJobs().catch(() => undefined);
      await loadStatus().catch(() => undefined);
      return res;
    } catch (e) {
      agentTyping.value = false;
      throw e;
    }
  }

  async function killJob(jobId: string) {
    await jobApi.kill(jobId);
    agentTyping.value = false;
    applyStatusSnapshot({ currentJobId: null, currentJobIds: [], queueLength: 0 });
    await loadJobs();
    await loadStatus().catch(() => undefined);
  }

  async function killAllJobs() {
    killAllBusy.value = true;
    try {
      const res = await jobApi.killAll();
      agentTyping.value = false;
      applyStatusSnapshot({ currentJobId: null, currentJobIds: [], queueLength: 0 });
      await loadJobs();
      await loadStatus().catch(() => undefined);
      return res;
    } finally {
      killAllBusy.value = false;
    }
  }

  /** PM approves docs-first phase → enqueue code. */
  async function approveDocs(jobId: string) {
    agentTyping.value = true;
    progressAfterId.value = 0;
    progressLines.value = [];
    watchProgress();
    try {
      const res = await jobApi.approveDocs(jobId);
      if (selectedJobId.value === jobId && res.job) {
        currentJob.value = { ...currentJob.value, ...(res.job as Job) };
        if (isJobStatusBusy(res.job.status)) {
          agentTyping.value = true;
          watchProgress();
        }
      }
      await loadJobs();
      if (selectedJobId.value === jobId) {
        await pollProgress(true).catch(() => undefined);
      }
      return res;
    } catch (e) {
      agentTyping.value = false;
      progressLive.value = false;
      stopProgressPolling();
      throw e;
    }
  }

  /** PM approves plan-first phase → enqueue code. */
  async function approvePlan(jobId: string) {
    agentTyping.value = true;
    progressAfterId.value = 0;
    progressLines.value = [];
    watchProgress();
    try {
      const res = await jobApi.approvePlan(jobId);
      if (selectedJobId.value === jobId && res.job) {
        currentJob.value = { ...currentJob.value, ...(res.job as Job) };
        if (isJobStatusBusy(res.job.status)) {
          agentTyping.value = true;
          watchProgress();
        }
      }
      await loadJobs();
      if (selectedJobId.value === jobId) {
        await pollProgress(true).catch(() => undefined);
      }
      return res;
    } catch (e) {
      agentTyping.value = false;
      progressLive.value = false;
      stopProgressPolling();
      throw e;
    }
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

  /** Close open issue / job when switching Flow project. */
  function clearOpenSelection() {
    stopProgressPolling();
    selectedTaskIid.value = null;
    taskDetail.value = null;
    selectedJobId.value = null;
    currentJob.value = null;
    chat.value = [];
    progressLines.value = [];
    progressAfterId.value = 0;
    progressLive.value = false;
    agentTyping.value = false;
    jobLoading.value = false;
  }

  /** After SSE reconnect / tab wake — catch up status, jobs, open job progress+chat. */
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  let resyncInFlight = false;
  async function resyncRealtime() {
    if (resyncTimer) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      resyncTimer = undefined;
      if (resyncInFlight) return;
      resyncInFlight = true;
      void (async () => {
        try {
          await Promise.all([loadStatus(), loadJobs()]).catch(() => undefined);
          const id = selectedJobId.value;
          if (!id) return;
          const busy = isJobStatusBusy(
            (jobs.value.find((j) => j.id === id) || currentJob.value)?.status,
          );
          if (busy) {
            agentTyping.value = true;
            watchProgress();
          }
          await Promise.all([pollProgress(false), refreshJobChat(id)]).catch(
            () => undefined,
          );
        } finally {
          resyncInFlight = false;
        }
      })();
    }, 250);
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
    labelCatalog,
    projectMilestones,
    milestoneFilter,
    labelFilter,
    setMilestoneFilter,
    setLabelFilter,
    hydrateTaskFilters,
    loading,
    jobLoading,
    statusText,
    runningJobIds,
    queueLength,
    activeJobCount,
    canKillAll,
    killAllBusy,
    loadTasks,
    loadJobs,
    loadMeta,
    loadStatus,
    resyncRealtime,
    applyStatusSnapshot,
    scheduleLoadJobs,
    applyRealtimeProgress,
    applyRealtimeJob,
    applyRealtimeChat,
    selectJob,
    selectTask,
    refreshJobChat,
    fetchTaskDetail,
    saveDevNotes,
    pollProgress,
    watchProgress,
    shouldPollProgress,
    isSelectedJobAgentBusy,
    startJobs,
    sendContinue,
    sendAsk,
    killJob,
    killAllJobs,
    approveDocs,
    approvePlan,
    resetAgentWindow,
    setJobStatus,
    deleteJob,
    createAdhocSession,
    fetchIssueDraft,
    createGitlabIssue,
    refreshAll,
    clearOpenSelection,
  };
});
