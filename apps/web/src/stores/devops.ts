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
  const buildsHasMore = ref(false);
  const buildsLoadingMore = ref(false);
  const BUILDS_PAGE = 40;
  /** Last cursor id for the next loadMore page. */
  let buildsNextCursor: string | null = null;
  let buildsFetchSeq = 0;
  /** Soft highlight job ids when SSE status changes. */
  const flashBuildIds = ref<Record<string, number>>({});
  const PREV_STATUS = new Map<string, BuildStatus>();

  function oldestBuildId(list: BuildJob[]): string | null {
    if (!list.length) return null;
    const oldest = [...list].sort((a, b) => {
      const ca = Date.parse(a.createdAt || "") || 0;
      const cb = Date.parse(b.createdAt || "") || 0;
      if (ca !== cb) return ca - cb;
      return (a.id || "").localeCompare(b.id || "");
    })[0];
    return oldest?.id ?? null;
  }

  function markFlash(id: string) {
    const token = Date.now();
    flashBuildIds.value = { ...flashBuildIds.value, [id]: token };
    window.setTimeout(() => {
      if (flashBuildIds.value[id] !== token) return;
      const next = { ...flashBuildIds.value };
      delete next[id];
      flashBuildIds.value = next;
    }, 1200);
  }

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
  /** Last build shown on the Build tab — kept after completion so logs stay visible. */
  const lastLiveBuildId = ref<string | null>(null);
  const loading = ref(false);
  const history = ref<BuildJob[]>([]);
  const historyTotal = ref(0);
  const historyPage = ref(1);
  /** History tab shows at most this many recent builds. */
  const historyPageSize = ref(40);
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

  let logEs: EventSource | null = null;
  let streamingId: string | null = null;
  let logStreamStopped = false;
  let logReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let syncGen = 0;

  let viewLogEs: EventSource | null = null;
  let viewStreamingId: string | null = null;
  let viewLogGen = 0;
  let viewLogsLoadedFor: string | null = null;
  let liveLogsLoadedFor: string | null = null;

  /** Job actively executing right now (queue snapshot or local running status). */
  function resolveRunningBuildId(): string | null {
    const fromQueue = queue.value.currentBuildId;
    if (queue.value.running && fromQueue) return fromQueue;
    return builds.value.find((b) => b.status === "running")?.id ?? null;
  }

  const liveBuildId = computed(() => {
    const running = resolveRunningBuildId();
    if (running) return running;
    return lastLiveBuildId.value;
  });

  const liveBuild = computed(
    () => builds.value.find((b) => b.id === liveBuildId.value) || null,
  );

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
    const prev = PREV_STATUS.get(job.id);
    if (prev && prev !== job.status) markFlash(job.id);
    PREV_STATUS.set(job.id, job.status);

    const idx = builds.value.findIndex((b) => b.id === job.id);
    if (idx >= 0) builds.value[idx] = job;
    else builds.value = [job, ...builds.value];

    if (job.status === "running") {
      lastLiveBuildId.value = job.id;
      liveLogsLoadedFor = null;
      const queuedIds = queue.value.queuedIds.filter((id) => id !== job.id);
      queue.value = {
        ...queue.value,
        running: true,
        currentBuildId: job.id,
        queuedIds,
        queued: queuedIds.length,
      };
    } else if (TERMINAL_STATUSES.includes(job.status)) {
      if (queue.value.currentBuildId === job.id) {
        queue.value = {
          ...queue.value,
          running: false,
          currentBuildId: null,
        };
      }
      // Keep already-streamed lines — re-fetching the full log freezes the UI.
      if (lastLiveBuildId.value === job.id) {
        if (logLines.value.length > 0) {
          liveLogsLoadedFor = job.id;
        } else {
          liveLogsLoadedFor = null;
        }
      }
    }

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
    const runningId = resolveRunningBuildId();

    if (runningId) {
      lastLiveBuildId.value = runningId;
      // Already attached — do not clear liveLogsLoadedFor or restart the stream.
      if (streamingId === runningId && logEs) return;
      liveLogsLoadedFor = null;
      if (streamingId !== runningId) logLines.value = [];
      closeLogStream();
      if (gen !== syncGen) return;
      await attachLogStream(runningId, gen, logLines);
      return;
    }

    const focusId = lastLiveBuildId.value;
    // Job may already be terminal on the queue SSE while log SSE is still
    // flushing — do not close it or we drop the tail and re-GET a huge /log.
    if (focusId && streamingId === focusId && logEs) {
      return;
    }

    closeLogStream();
    if (!focusId) return;

    const job = findBuild(focusId);
    const pendingInQueue =
      job?.status === "queued" ||
      (!job && queue.value.queuedIds.includes(focusId));

    if (pendingInQueue) {
      liveLogsLoadedFor = null;
      if (streamingId !== focusId) logLines.value = [];
      closeLogStream();
      if (gen !== syncGen) return;
      await attachLogStream(focusId, gen, logLines);
      return;
    }

    if (!job || !TERMINAL_STATUSES.includes(job.status)) return;
    // Prefer streamed buffer — avoid replacing tens of thousands of lines mid-paint.
    if (logLines.value.length > 0) {
      liveLogsLoadedFor = focusId;
      return;
    }
    if (liveLogsLoadedFor === focusId) return;

    const res = await devopsApi.log(focusId);
    if (gen !== syncGen) return;
    logLines.value = res.lines;
    liveLogsLoadedFor = focusId;
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
      if (resolveRunningBuildId() !== id) return;
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
        if (ev.job.status === "running") {
          lastLiveBuildId.value = ev.job.id;
          liveLogsLoadedFor = null;
          const queuedIds = queue.value.queuedIds.filter((qid) => qid !== ev.job.id);
          queue.value = {
            ...queue.value,
            running: true,
            currentBuildId: ev.job.id,
            queuedIds,
            queued: queuedIds.length,
          };
        }
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("done", (e) => {
      if (gen !== syncGen) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data) as { job: BuildJob };
        if (ev.job) {
          lastLiveBuildId.value = ev.job.id;
          // Stream already delivered lines — mark loaded so we do not re-GET /log.
          liveLogsLoadedFor = ev.job.id;
          const i = builds.value.findIndex((b) => b.id === ev.job.id);
          if (i >= 0) builds.value[i] = ev.job;
          else builds.value = [ev.job, ...builds.value];
          if (TERMINAL_STATUSES.includes(ev.job.status)) {
            if (queue.value.currentBuildId === ev.job.id) {
              queue.value = {
                ...queue.value,
                running: false,
                currentBuildId: null,
              };
            }
          }
        }
      } catch {
        /* ignore */
      }
      es.close();
      if (logEs === es) {
        logEs = null;
        streamingId = null;
      }
      void syncLiveStream();
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

  async function fetchHistory(page = 1) {
    historyLoading.value = true;
    try {
      const limit = historyPageSize.value;
      const offset = Math.max(0, (page - 1) * limit);
      const res = await devopsApi.listBuilds({
        limit,
        offset,
        status: historyStatus.value,
      });
      history.value = res.builds;
      historyTotal.value = res.total ?? res.builds.length;
      historyPage.value = page;
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
    const seq = ++buildsFetchSeq;
    try {
      const limit = Math.min(
        200,
        Math.max(BUILDS_PAGE, builds.value.length || BUILDS_PAGE),
      );
      const [s, list] = await Promise.all([
        devopsApi.listScripts(),
        devopsApi.listBuilds({ limit }),
      ]);
      if (seq !== buildsFetchSeq) return;
      scripts.value = s.scripts;
      builds.value = list.builds;
      buildsHasMore.value = Boolean(list.hasMore);
      buildsNextCursor = oldestBuildId(builds.value);
      for (const b of list.builds) PREV_STATUS.set(b.id, b.status);
      queue.value = list.queue;
      const running = resolveRunningBuildId();
      if (running) lastLiveBuildId.value = running;
      else if (list.builds[0]) lastLiveBuildId.value = list.builds[0].id;
      await syncLiveStream();
    } catch (err) {
      errorText.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function loadMoreBuilds() {
    if (buildsLoadingMore.value || !buildsHasMore.value) return;
    const lastId = buildsNextCursor || oldestBuildId(builds.value);
    if (!lastId) return;
    buildsLoadingMore.value = true;
    const seq = buildsFetchSeq;
    try {
      const data = await devopsApi.listBuilds({
        limit: BUILDS_PAGE,
        lastId,
      });
      if (seq !== buildsFetchSeq) return;
      const incoming = data.builds || [];
      const pageLast = incoming[incoming.length - 1]?.id;
      if (pageLast) buildsNextCursor = pageLast;
      const seen = new Set(builds.value.map((b) => b.id));
      const appended = incoming.filter((b) => !seen.has(b.id));
      if (appended.length) {
        builds.value = [...builds.value, ...appended];
        for (const b of appended) PREV_STATUS.set(b.id, b.status);
      }
      buildsHasMore.value = Boolean(data.hasMore);
    } finally {
      buildsLoadingMore.value = false;
    }
  }

  async function trigger(scriptId: string, note?: string) {
    triggeringId.value = scriptId;
    try {
      const res = await devopsApi.trigger(scriptId, note);
      lastLiveBuildId.value = res.job.id;
      liveLogsLoadedFor = null;
      logLines.value = [];
      selectedId.value = res.job.id;
      upsertBuild(res.job);
      applyQueue(res.queue);
      await syncLiveStream();
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
  let eventsConnecting = false;

  async function ensureFreshToken() {
    const exp = getAccessExpiresAt();
    if (!getAccessToken() || (exp && exp < Date.now() + 20_000)) {
      await refreshAccessToken().catch(() => false);
    }
  }

  /** Queue/job SSE — safe to call repeatedly; stays up across Chat/Work/Build nav. */
  function connectEvents() {
    eventsStopped = false;
    logStreamStopped = false;
    if (
      eventsEs &&
      eventsEs.readyState !== EventSource.CLOSED
    ) {
      return;
    }
    if (eventsConnecting) return;
    eventsConnecting = true;
    void (async () => {
      try {
        await ensureFreshToken();
        if (eventsStopped) return;
        if (eventsEs && eventsEs.readyState !== EventSource.CLOSED) return;
        eventsEs?.close();
        const es = new EventSource(devopsEventsUrl());
        eventsEs = es;
        es.addEventListener("queue", (e) => {
          try {
            const ev = JSON.parse((e as MessageEvent).data) as
              | BuildQueueSnapshot
              | { snapshot: BuildQueueSnapshot };
            applyQueue(
              "snapshot" in ev && ev.snapshot
                ? ev.snapshot
                : (ev as BuildQueueSnapshot),
            );
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
      } finally {
        eventsConnecting = false;
      }
    })();
  }

  /** Full teardown — logout / lose devops access. */
  function disconnect() {
    eventsStopped = true;
    logStreamStopped = true;
    eventsConnecting = false;
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
    buildsHasMore,
    buildsLoadingMore,
    flashBuildIds,
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
    loadMoreBuilds,
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
    syncLiveStream,
    connectEvents,
    disconnect,
  };
});
