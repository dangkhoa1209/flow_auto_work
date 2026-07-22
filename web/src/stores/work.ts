import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
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
  };
  runCount?: number;
  agentId?: string;
  commitSha?: string;
  error?: string;
  summary?: string;
  branch?: string;
  requireDocsFirst?: boolean;
  lastQuestion?: string;
  devNotes?: string;
  techLeadNotes?: string;
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
    Array<{ role: string; body: string; kind?: string; createdAt?: string }>
  >([]);
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
    const data = await api<{ tasks: Task[] }>("/api/tasks");
    tasks.value = data.tasks || [];
  }

  async function loadJobs() {
    const data = await api<{ jobs: Job[] }>("/api/jobs?limit=40");
    jobs.value = data.jobs || [];
    // Keep currentJob.status in sync so Progress polling knows job is live
    if (selectedJobId.value) {
      const j = jobs.value.find((x) => x.id === selectedJobId.value);
      if (j) {
        currentJob.value = currentJob.value
          ? { ...currentJob.value, ...j }
          : j;
      }
    }
  }

  async function loadMeta() {
    const [m, l] = await Promise.all([
      api<{ members: Array<{ username: string; name?: string }> }>(
        "/api/meta/members",
      ).catch(() => ({ members: [] })),
      api<{ labels: string[] }>("/api/meta/labels").catch(() => ({
        labels: [],
      })),
    ]);
    members.value = m.members || [];
    labels.value = l.labels || [];
  }

  async function loadStatus() {
    const s = await api<{
      queueLength?: number;
      currentJobId?: string | null;
    }>("/api/status");
    statusText.value = s.currentJobId
      ? `Running ${s.currentJobId}`
      : s.queueLength
        ? `Queue ${s.queueLength}`
        : "Idle";
  }

  async function selectJob(id: string) {
    selectedJobId.value = id;
    progressAfterId.value = 0;
    progressLines.value = [];
    chat.value = [];
    jobLoading.value = true;
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
      const iid = detail.job?.issue?.issueIid;
      if (iid && iid > 0 && !isAdhocJob(detail.job)) {
        selectedTaskIid.value = iid;
        const res = await api<{ detail: TaskDetail }>(`/api/tasks/${iid}`);
        if (selectedJobId.value !== id) return;
        taskDetail.value = res.detail;
      } else {
        selectedTaskIid.value = null;
        taskDetail.value = null;
      }
      await pollProgress(true);
    } finally {
      if (selectedJobId.value === id) jobLoading.value = false;
    }
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
      currentJob.value = { ...currentJob.value, status: data.status };
    }
  }

  /** Call when starting Run / Gửi so Progress polls immediately */
  function watchProgress() {
    progressLive.value = true;
    if (currentJob.value) {
      currentJob.value = { ...currentJob.value, status: "running" };
    }
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
    if (res.jobId) await selectJob(res.jobId);
    return res;
  }

  async function sendContinue(message: string) {
    if (!selectedJobId.value) throw new Error("Chưa chọn job");
    watchProgress();
    await api(`/api/jobs/${selectedJobId.value}/continue`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    await selectJob(selectedJobId.value);
  }

  async function sendAsk(question: string) {
    if (!selectedJobId.value) throw new Error("Chưa chọn job");
    watchProgress();
    await api(`/api/jobs/${selectedJobId.value}/ask`, {
      method: "POST",
      body: JSON.stringify({ question }),
    });
    await selectJob(selectedJobId.value);
  }

  async function sendClarify(answer: string) {
    if (!selectedJobId.value) throw new Error("Chưa chọn job");
    await api(`/api/jobs/${selectedJobId.value}/clarify`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
  }

  async function killJob(jobId: string) {
    await api(`/api/jobs/${jobId}/kill`, {
      method: "POST",
      body: JSON.stringify({}),
    });
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
    selectJob,
    selectTask,
    saveDevNotes,
    pollProgress,
    watchProgress,
    shouldPollProgress,
    startJobs,
    sendContinue,
    sendAsk,
    sendClarify,
    killJob,
    createAdhocSession,
    fetchIssueDraft,
    createGitlabIssue,
    refreshAll,
  };
});
