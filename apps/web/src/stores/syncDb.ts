import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  syncDbApi,
  syncDbEventsUrl,
  type SyncDbCapability,
  type SyncDbJob,
  type SyncDbLogLine,
  type SyncDbQueueSnapshot,
} from "@/api/syncDbApi";
import { refreshAccessToken } from "@/api/client";
import { getAccessExpiresAt, getAccessToken } from "@/api/tokenStorage";

const emptyQueue = (): SyncDbQueueSnapshot => ({
  concurrency: 1,
  running: false,
  currentJobId: null,
  currentDbName: null,
  currentProgress: null,
  queued: 0,
  queuedIds: [],
  shuttingDown: false,
});

export const useSyncDbStore = defineStore("syncDb", () => {
  const capability = ref<SyncDbCapability | null>(null);
  const queue = ref<SyncDbQueueSnapshot>(emptyQueue());
  const jobs = ref<SyncDbJob[]>([]);
  const history = ref<SyncDbJob[]>([]);
  const triggering = ref(false);
  const lastTriggerAt = ref(0);
  const logLines = ref<SyncDbLogLine[]>([]);
  const viewingJobId = ref<string | null>(null);
  const errorText = ref("");

  let eventsEs: EventSource | null = null;
  let projectIdWatched: string | null = null;

  const headerLabel = computed(() => {
    if (queue.value.shuttingDown) return "SYNC OFF";
    const p = queue.value.currentProgress;
    if (queue.value.running && queue.value.currentDbName) {
      if (p && p.total > 0) {
        const cur = p.current[0] ? ` · ${p.current[0]}` : "";
        return `SYNC ${p.done}/${p.total}${cur}`;
      }
      return `RUNNING · ${queue.value.currentDbName}`;
    }
    if (queue.value.queued > 0) return `Queue: ${queue.value.queued}`;
    return "SYNC";
  });

  const idleDot = computed(() => (queue.value.running ? "wip" : "idle"));

  const canShow = computed(() => Boolean(capability.value?.available));

  const busy = computed(
    () => queue.value.running || queue.value.queued > 0 || triggering.value,
  );

  function upsertJob(job: SyncDbJob) {
    const i = jobs.value.findIndex((j) => j.id === job.id);
    if (i >= 0) jobs.value[i] = job;
    else jobs.value = [job, ...jobs.value].slice(0, 80);
    const hi = history.value.findIndex((j) => j.id === job.id);
    if (hi >= 0) history.value[hi] = job;
    else if (job.status !== "queued" && job.status !== "running") {
      history.value = [job, ...history.value].slice(0, 40);
    }
  }

  async function refreshCapability(projectId: string | null) {
    if (!projectId) {
      capability.value = null;
      return;
    }
    try {
      const data = await syncDbApi.capability(projectId);
      capability.value = data.capability;
      queue.value = data.queue;
    } catch (e) {
      capability.value = null;
      errorText.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function refreshHistory(projectId?: string) {
    try {
      const data = await syncDbApi.listJobs({
        limit: 30,
        projectId,
      });
      queue.value = data.queue;
      history.value = data.jobs;
      jobs.value = data.jobs.filter(
        (j) => j.status === "queued" || j.status === "running",
      );
    } catch (e) {
      errorText.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function ensureTokenFresh() {
    const exp = getAccessExpiresAt();
    if (exp && exp - Date.now() < 60_000) {
      await refreshAccessToken().catch(() => undefined);
    }
  }

  function stopEvents() {
    if (eventsEs) {
      eventsEs.close();
      eventsEs = null;
    }
  }

  async function startEvents() {
    stopEvents();
    await ensureTokenFresh();
    if (!getAccessToken()) return;
    const es = new EventSource(syncDbEventsUrl());
    eventsEs = es;

    const onQueue = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as {
          snapshot?: SyncDbQueueSnapshot;
        };
        if (data.snapshot) queue.value = data.snapshot;
      } catch {
        /* */
      }
    };
    const onJob = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as { job?: SyncDbJob };
        if (data.job) upsertJob(data.job);
      } catch {
        /* */
      }
    };
    const onProgress = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as {
          jobId?: string;
          progress?: SyncDbJob["progress"];
        };
        if (!data.jobId || !data.progress) return;
        const job = jobs.value.find((j) => j.id === data.jobId);
        if (job) {
          job.progress = data.progress;
          upsertJob({ ...job });
        }
        if (queue.value.currentJobId === data.jobId) {
          queue.value = {
            ...queue.value,
            currentProgress: data.progress,
            currentDbName: data.progress.dbName || queue.value.currentDbName,
          };
        }
      } catch {
        /* */
      }
    };
    const onDone = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as { job?: SyncDbJob };
        if (data.job) upsertJob(data.job);
      } catch {
        /* */
      }
    };

    es.addEventListener("queue", onQueue as EventListener);
    es.addEventListener("job", onJob as EventListener);
    es.addEventListener("progress", onProgress as EventListener);
    es.addEventListener("done", onDone as EventListener);
    es.onerror = () => {
      /* browser auto-reconnects */
    };
  }

  async function bootstrap(projectId: string | null) {
    projectIdWatched = projectId;
    await refreshCapability(projectId);
    if (capability.value?.featureVisible) {
      await refreshHistory();
      await startEvents();
    } else {
      stopEvents();
    }
  }

  async function onProjectChange(projectId: string | null) {
    if (projectId === projectIdWatched) {
      await refreshCapability(projectId);
      return;
    }
    await bootstrap(projectId);
  }

  async function trigger(projectId: string) {
    const now = Date.now();
    if (now - lastTriggerAt.value < 400) return;
    lastTriggerAt.value = now;
    if (triggering.value) return;
    triggering.value = true;
    errorText.value = "";
    try {
      const data = await syncDbApi.trigger(projectId);
      queue.value = data.queue;
      upsertJob(data.job);
    } catch (e) {
      errorText.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      triggering.value = false;
    }
  }

  async function cancel(jobId: string) {
    const data = await syncDbApi.cancel(jobId);
    queue.value = data.queue;
    upsertJob(data.job);
  }

  function dispose() {
    stopEvents();
    projectIdWatched = null;
  }

  return {
    capability,
    queue,
    jobs,
    history,
    triggering,
    logLines,
    viewingJobId,
    errorText,
    headerLabel,
    idleDot,
    canShow,
    busy,
    bootstrap,
    onProjectChange,
    refreshCapability,
    refreshHistory,
    trigger,
    cancel,
    dispose,
  };
});
