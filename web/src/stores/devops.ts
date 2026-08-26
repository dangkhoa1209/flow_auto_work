import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  devopsApi,
  devopsBuildStreamUrl,
  devopsEventsUrl,
  type BuildJob,
  type BuildLogLine,
  type BuildQueueSnapshot,
  type BuildScript,
  type BuildStatus,
} from "@/api/devopsApi";

const TERMINAL_STATUSES: readonly BuildStatus[] = [
  "success",
  "failed",
  "cancelled",
  "timeout",
];
import { refreshAccessToken } from "@/api/client";
import { getAccessExpiresAt, getAccessToken } from "@/api/tokenStorage";

export type DevopsTab = "build" | "history" | "config";

export const useDevopsStore = defineStore("devops", () => {
  /** Active dashboard tab — header tabs live in DevopsLayout. */
  const activeTab = ref<DevopsTab>("build");
  const scripts = ref<BuildScript[]>([]);
  const builds = ref<BuildJob[]>([]);
  const queue = ref<BuildQueueSnapshot>({
    concurrency: 1,
    running: false,
    currentBuildId: null,
    queued: 0,
    queuedIds: [],
    shuttingDown: false,
  });
  const selectedId = ref<string | null>(null);
  const logLines = ref<BuildLogLine[]>([]);
  const viewLogLines = ref<BuildLogLine[]>([]);
  const viewingBuildId = ref<string | null>(null);
  const loading = ref(false);
  const history = ref<BuildJob[]>([]);
  const historyTotal = ref(0);
  const historyPage = ref(1);
  const historyPageSize = ref(20);
  const historyStatus = ref<BuildStatus | undefined>(undefined);
  const historyLoading = ref(false);
  const triggeringId = ref<string | null>(null);
  const cancellingId = ref<string | null>(null);
  const stdinBusy = ref(false);
  const savingScript = ref(false);
  const deletingScriptId = ref<string | null>(null);
  const errorText = ref("");

  const selected = computed(
    () => builds.value.find((b) => b.id === selectedId.value) || null,
  );

  function resolveLiveBuildId(): string | null {
    const runningId = queue.value.currentBuildId;
    if (runningId) {
      const job = builds.value.find((b) => b.id === runningId);
      if (job?.status === "running") return runningId;
    }
    const anyRunning = builds.value.find((b) => b.status === "running");
    if (anyRunning) return anyRunning.id;
    return null;
  }

  const liveBuildId = computed(() => resolveLiveBuildId());

  const liveBuild = computed(
    () => builds.value.find((b) => b.id === liveBuildId.value) || null,
  );

  let logEs: EventSource | null = null;
  let streamingId: string | null = null;
  let logStreamStopped = false;
  let logReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let syncGen = 0;

  let viewLogEs: EventSource | null = null;
  let viewStreamingId: string | null = null;
  let viewLogGen = 0;
  let viewLogsLoadedFor: string | null = null;

  function clearLogReconnect() {
    if (logReconnectTimer) {
      clearTimeout(logReconnectTimer);
      logReconnectTimer = undefined;
    }
  }

  function closeLogStream() {
    clearLogReconnect();
    logEs?.close();
    logEs = null;
    streamingId = null;
  }

  function closeViewLogStream() {
    viewLogEs?.close();
    viewLogEs = null;
    viewStreamingId = null;
  }

  function findBuild(id: string): BuildJob | undefined {
    return builds.value.find((b) => b.id === id);
  }

  function upsertBuild(job: BuildJob) {
    const idx = builds.value.findIndex((b) => b.id === job.id);
    if (idx >= 0) builds.value[idx] = job;
    else builds.value = [job, ...builds.value];

    const hIdx = history.value.findIndex((b) => b.id === job.id);
    if (hIdx >= 0) {
      history.value[hIdx] = job;
    } else if (
      TERMINAL_STATUSES.includes(job.status) &&
      historyPage.value === 1
    ) {
      // A build just finished — refresh page 1 so it shows up in history.
      void fetchHistory(1).catch(() => undefined);
    }

    syncLiveStream();
  }

  async function syncLiveStream() {
    const gen = ++syncGen;
    const id = resolveLiveBuildId();
    if (!id) {
      closeLogStream();
      return;
    }
    const job = findBuild(id);
    if (!job || job.status === "queued") {
      if (streamingId !== id) logLines.value = [];
      closeLogStream();
      return;
    }
    if (streamingId === id && logEs) return;

    if (streamingId !== id) logLines.value = [];
    closeLogStream();
    if (gen !== syncGen) return;
    await attachLogStream(id, gen, logLines);
  }

  async function syncViewLogs(id: string) {
    const gen = ++viewLogGen;
    viewingBuildId.value = id;

    let job = findBuild(id);
    if (!job) {
      try {
        job = (await devopsApi.getBuild(id)).job;
        const idx = builds.value.findIndex((b) => b.id === job!.id);
        if (idx >= 0) builds.value[idx] = job;
        else builds.value = [job, ...builds.value];
      } catch {
        return;
      }
    }
    if (gen !== viewLogGen) return;

    if (TERMINAL_STATUSES.includes(job.status)) {
      closeViewLogStream();
      if (viewLogsLoadedFor === id && viewLogLines.value.length > 0) return;
      const res = await devopsApi.log(id);
      if (gen !== viewLogGen) return;
      viewLogLines.value = res.lines;
      viewLogsLoadedFor = id;
      return;
    }

    viewLogsLoadedFor = null;
    if (viewStreamingId !== id) viewLogLines.value = [];
    closeViewLogStream();
    if (gen !== viewLogGen) return;
    await attachViewLogStream(id, gen);
  }

  function scheduleLogReconnect(id: string, gen: number) {
    if (logStreamStopped || gen !== syncGen) return;
    const job = builds.value.find((b) => b.id === id);
    if (!job || (job.status !== "running" && job.status !== "queued")) return;
    clearLogReconnect();
    logReconnectTimer = setTimeout(() => {
      logReconnectTimer = undefined;
      if (logStreamStopped || gen !== syncGen) return;
      if (resolveLiveBuildId() !== id) return;
      void attachLogStream(id, gen, logLines);
    }, 2000);
  }

  async function attachLogStream(
    id: string,
    gen: number,
    target: typeof logLines,
  ) {
    if (gen !== syncGen) return;
    if (streamingId === id && logEs) return;
    closeLogStream();
    if (gen !== syncGen) return;
    await ensureFreshToken();
    if (gen !== syncGen) return;

    const es = new EventSource(devopsBuildStreamUrl(id));
    logEs = es;
    streamingId = id;

    es.addEventListener("log", (e) => {
      if (gen !== syncGen) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data) as BuildLogLine & {
          buildId?: string;
        };
        if (ev.buildId && ev.buildId !== id) return;
        target.value.push(ev);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("job", (e) => {
      if (gen !== syncGen) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data) as { job: BuildJob };
        if (ev.job?.id !== id) return;
        const i = builds.value.findIndex((b) => b.id === ev.job.id);
        if (i >= 0) builds.value[i] = ev.job;
        else builds.value = [ev.job, ...builds.value];
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("done", (e) => {
      if (gen !== syncGen) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data) as { job: BuildJob };
        if (ev.job) {
          const i = builds.value.findIndex((b) => b.id === ev.job.id);
          if (i >= 0) builds.value[i] = ev.job;
          else builds.value = [ev.job, ...builds.value];
        }
      } catch {
        /* ignore */
      }
      es.close();
      if (logEs === es) {
        logEs = null;
        streamingId = null;
      }
    });
    es.onerror = () => {
      if (gen !== syncGen) return;
      es.close();
      if (logEs === es) {
        logEs = null;
        streamingId = null;
      }
      scheduleLogReconnect(id, gen);
    };
  }

  async function attachViewLogStream(id: string, gen: number) {
    if (gen !== viewLogGen) return;
    if (viewStreamingId === id && viewLogEs) return;
    closeViewLogStream();
    if (gen !== viewLogGen) return;
    await ensureFreshToken();
    if (gen !== viewLogGen) return;

    const es = new EventSource(devopsBuildStreamUrl(id));
    viewLogEs = es;
    viewStreamingId = id;

    es.addEventListener("log", (e) => {
      if (gen !== viewLogGen) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data) as BuildLogLine & {
          buildId?: string;
        };
        if (ev.buildId && ev.buildId !== id) return;
        viewLogLines.value.push(ev);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("job", (e) => {
      if (gen !== viewLogGen) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data) as { job: BuildJob };
        if (ev.job?.id !== id) return;
        const i = builds.value.findIndex((b) => b.id === ev.job.id);
        if (i >= 0) builds.value[i] = ev.job;
        else builds.value = [ev.job, ...builds.value];
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("done", (e) => {
      if (gen !== viewLogGen) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data) as { job: BuildJob };
        if (ev.job) {
          const i = builds.value.findIndex((b) => b.id === ev.job.id);
          if (i >= 0) builds.value[i] = ev.job;
          else builds.value = [ev.job, ...builds.value];
        }
      } catch {
        /* ignore */
      }
      es.close();
      if (viewLogEs === es) {
        viewLogEs = null;
        viewStreamingId = null;
      }
    });
    es.onerror = () => {
      if (gen !== viewLogGen) return;
      es.close();
      if (viewLogEs === es) {
        viewLogEs = null;
        viewStreamingId = null;
      }
      if (gen !== viewLogGen || viewingBuildId.value !== id) return;
      setTimeout(() => {
        if (gen !== viewLogGen || viewingBuildId.value !== id) return;
        void attachViewLogStream(id, gen);
      }, 2000);
    };
  }

  async function selectBuild(id: string) {
    selectedId.value = id;
    await syncLiveStream();
  }

  /** Select a job that may not be in the live list yet (e.g. old history page). */
  async function selectBuildJob(job: BuildJob) {
    const idx = builds.value.findIndex((b) => b.id === job.id);
    if (idx < 0) builds.value = [job, ...builds.value];
    selectedId.value = job.id;
    await syncViewLogs(job.id);
  }

  async function fetchHistory(page = historyPage.value) {
    historyLoading.value = true;
    try {
      const res = await devopsApi.listBuilds({
        limit: historyPageSize.value,
        offset: (Math.max(1, page) - 1) * historyPageSize.value,
        status: historyStatus.value,
      });
      history.value = res.builds;
      historyTotal.value = res.total ?? res.builds.length;
      historyPage.value = Math.max(1, page);
      applyQueue(res.queue);
    } finally {
      historyLoading.value = false;
    }
  }

  async function setHistoryStatus(status: BuildStatus | undefined) {
    historyStatus.value = status;
    await fetchHistory(1);
  }

  function applyQueue(snap: BuildQueueSnapshot) {
    queue.value = snap;
    void syncLiveStream();
  }

  async function refresh() {
    loading.value = true;
    errorText.value = "";
    try {
      const [s, list] = await Promise.all([
        devopsApi.listScripts(),
        devopsApi.listBuilds({ limit: 80 }),
      ]);
      scripts.value = s.scripts;
      builds.value = list.builds;
      queue.value = list.queue;
      await syncLiveStream();
    } catch (err) {
      errorText.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function trigger(scriptId: string, note?: string) {
    triggeringId.value = scriptId;
    try {
      const res = await devopsApi.trigger(scriptId, note);
      upsertBuild(res.job);
      applyQueue(res.queue);
      await selectBuild(res.job.id);
      return res.job;
    } finally {
      triggeringId.value = null;
    }
  }

  async function cancel(id: string) {
    cancellingId.value = id;
    try {
      const res = await devopsApi.cancel(id);
      upsertBuild(res.job);
      applyQueue(res.queue);
      return res.job;
    } finally {
      cancellingId.value = null;
    }
  }

  async function sendStdin(id: string, data: string, secret?: boolean) {
    stdinBusy.value = true;
    try {
      await devopsApi.stdin(id, data, secret);
    } finally {
      stdinBusy.value = false;
    }
  }

  async function toggleScript(id: string, active: boolean) {
    const res = await devopsApi.updateScript(id, { active });
    const idx = scripts.value.findIndex((s) => s.id === res.script.id);
    if (idx >= 0) scripts.value[idx] = res.script;
    return res.script;
  }

  async function saveScript(opts: {
    id?: string;
    label: string;
    command: string;
    workingDir: string;
    timeoutSec?: number;
    active?: boolean;
  }) {
    savingScript.value = true;
    try {
      if (opts.id && scripts.value.some((s) => s.id === opts.id)) {
        const res = await devopsApi.updateScript(opts.id, opts);
        const idx = scripts.value.findIndex((s) => s.id === res.script.id);
        if (idx >= 0) scripts.value[idx] = res.script;
        else scripts.value = [res.script, ...scripts.value];
        return res.script;
      }
      const res = await devopsApi.createScript(opts);
      scripts.value = [res.script, ...scripts.value.filter((s) => s.id !== res.script.id)];
      return res.script;
    } finally {
      savingScript.value = false;
    }
  }

  async function removeScript(id: string) {
    deletingScriptId.value = id;
    try {
      await devopsApi.deleteScript(id);
      scripts.value = scripts.value.filter((s) => s.id !== id);
    } finally {
      deletingScriptId.value = null;
    }
  }

  let eventsEs: EventSource | null = null;
  let eventsStopped = false;

  async function ensureFreshToken() {
    const exp = getAccessExpiresAt();
    if (!getAccessToken() || (exp && exp < Date.now() + 20_000)) {
      await refreshAccessToken().catch(() => false);
    }
  }

  function connectEvents() {
    eventsStopped = false;
    logStreamStopped = false;
    void (async () => {
      await ensureFreshToken();
      if (eventsStopped) return;
      eventsEs?.close();
      const es = new EventSource(devopsEventsUrl());
      eventsEs = es;
      es.addEventListener("queue", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as
            | BuildQueueSnapshot
            | { snapshot: BuildQueueSnapshot };
          applyQueue("snapshot" in ev && ev.snapshot ? ev.snapshot : (ev as BuildQueueSnapshot));
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("job", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as { job: BuildJob };
          if (ev.job) upsertBuild(ev.job);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("done", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as { job: BuildJob };
          if (ev.job) upsertBuild(ev.job);
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        es.close();
        if (eventsEs === es) eventsEs = null;
        if (!eventsStopped) {
          setTimeout(() => {
            if (!eventsStopped) connectEvents();
          }, 2000);
        }
      };
    })();
  }

  function disconnect() {
    eventsStopped = true;
    logStreamStopped = true;
    eventsEs?.close();
    eventsEs = null;
    closeLogStream();
    closeViewLogStream();
    viewLogGen++;
  }

  return {
    activeTab,
    scripts,
    builds,
    queue,
    selectedId,
    selected,
    liveBuildId,
    liveBuild,
    logLines,
    viewLogLines,
    viewingBuildId,
    loading,
    history,
    historyTotal,
    historyPage,
    historyPageSize,
    historyStatus,
    historyLoading,
    triggeringId,
    cancellingId,
    stdinBusy,
    savingScript,
    deletingScriptId,
    errorText,
    refresh,
    trigger,
    cancel,
    sendStdin,
    saveScript,
    removeScript,
    toggleScript,
    selectBuild,
    selectBuildJob,
    fetchHistory,
    setHistoryStatus,
    connectEvents,
    disconnect,
  };
});
