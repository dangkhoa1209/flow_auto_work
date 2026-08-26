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
} from "@/api/devopsApi";
import { refreshAccessToken } from "@/api/client";
import { getAccessExpiresAt, getAccessToken } from "@/api/tokenStorage";

export const useDevopsStore = defineStore("devops", () => {
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
  const loading = ref(false);
  const triggeringId = ref<string | null>(null);
  const cancellingId = ref<string | null>(null);
  const savingScript = ref(false);
  const deletingScriptId = ref<string | null>(null);
  const errorText = ref("");

  const selected = computed(
    () => builds.value.find((b) => b.id === selectedId.value) || null,
  );

  let logEs: EventSource | null = null;
  let streamingId: string | null = null;

  function closeLogStream() {
    logEs?.close();
    logEs = null;
    streamingId = null;
  }

  function upsertBuild(job: BuildJob) {
    const idx = builds.value.findIndex((b) => b.id === job.id);
    if (idx >= 0) builds.value[idx] = job;
    else builds.value = [job, ...builds.value];
    if (
      selectedId.value === job.id &&
      job.status !== "queued" &&
      streamingId !== job.id
    ) {
      void attachLogStream(job.id);
    }
  }

  async function attachLogStream(id: string) {
    if (streamingId === id && logEs) return;
    closeLogStream();
    await ensureFreshToken();
    const es = new EventSource(devopsBuildStreamUrl(id));
    logEs = es;
    streamingId = id;
    es.addEventListener("log", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as BuildLogLine & {
          buildId?: string;
        };
        logLines.value = [...logLines.value, ev];
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("job", (e) => {
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
    });
    es.addEventListener("done", (e) => {
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
      es.close();
      if (logEs === es) {
        logEs = null;
        streamingId = null;
      }
    };
  }

  async function selectBuild(id: string) {
    selectedId.value = id;
    logLines.value = [];
    closeLogStream();
    const job = builds.value.find((b) => b.id === id);
    if (!job || job.status === "queued") return;
    await attachLogStream(id);
  }

  function applyQueue(snap: BuildQueueSnapshot) {
    queue.value = snap;
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

  async function saveScript(opts: {
    id?: string;
    label: string;
    command: string;
    workingDir: string;
    timeoutSec?: number;
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
    eventsEs?.close();
    eventsEs = null;
    closeLogStream();
  }

  return {
    scripts,
    builds,
    queue,
    selectedId,
    selected,
    logLines,
    loading,
    triggeringId,
    cancellingId,
    savingScript,
    deletingScriptId,
    errorText,
    refresh,
    trigger,
    cancel,
    saveScript,
    removeScript,
    selectBuild,
    connectEvents,
    disconnect,
  };
});
