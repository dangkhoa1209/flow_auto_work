<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { devopsApi } from "@/api/devopsApi";
import type { BuildJob, BuildLogLine, BuildScript, BuildStatus } from "@/api/devopsApi";
import { SearchOutlined } from "@ant-design/icons-vue";
import BuildFeedCard from "@/components/devops/BuildFeedCard.vue";
import BuildTerminal from "@/components/devops/BuildTerminal.vue";
import { useDevopsStore } from "@/stores/devops";
import { useSessionStore } from "@/stores/session";

const devops = useDevopsStore();
const session = useSessionStore();
const canConfigure = computed(() => session.canConfigureDevopsScripts);
const nowTick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | undefined;

const histDrawerOpen = ref(false);
const formOpen = ref(false);
const configCompact = ref(
  typeof window !== "undefined" ? window.matchMedia("(max-width: 1023px)").matches : false,
);
const editingId = ref<string | null>(null);
const stdinText = ref("");
const stdinSecret = ref(false);
const lastFailedToastId = ref<string | null>(null);
const scriptSearch = ref("");
const expandedBuildId = ref<string | null>(null);
const logCache = ref<Record<string, BuildLogLine[]>>({});
/** Mobile: collapse scripts list to free feed space. */
const scriptsCollapsed = ref(
  typeof window !== "undefined" ? window.matchMedia("(max-width: 900px)").matches : false,
);

/** Confirm re-run when the same script already has a queued/running job. */
const dupConfirm = reactive({
  open: false,
  script: null as BuildScript | null,
  queued: 0,
});

const form = reactive({
  id: "",
  label: "",
  command: "",
  workingDir: "",
  timeoutSec: undefined as number | undefined,
});

/** Per-script queue/running counts — trust queue.currentBuildId for running. */
function scriptQueueState(scriptId: string) {
  const runId = devops.queue.running ? devops.queue.currentBuildId : null;
  let running = 0;
  if (runId) {
    const run = devops.builds.find((b) => b.id === runId);
    if (run?.scriptId === scriptId) running = 1;
  }

  const queuedIds = new Set(
    devops.queue.queuedIds.filter((id) => id !== runId),
  );
  let queued = 0;
  for (const id of queuedIds) {
    const j = devops.builds.find((b) => b.id === id);
    if (j?.scriptId === scriptId) queued++;
  }
  for (const j of devops.builds) {
    if (j.scriptId !== scriptId || j.status !== "queued") continue;
    if (j.id === runId) continue;
    if (queuedIds.has(j.id)) continue;
    queued++;
  }
  return { running, queued };
}

function scriptBusyCount(scriptId: string) {
  const { running, queued } = scriptQueueState(scriptId);
  return running + queued;
}

const activeScripts = computed(() =>
  devops.scripts.filter((s) => s.active !== false),
);

const filteredScripts = computed(() => {
  const q = scriptSearch.value.trim().toLowerCase();
  return activeScripts.value.filter((s) => {
    if (!q) return true;
    return (
      s.label.toLowerCase().includes(q) ||
      s.command.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
    );
  });
});

const feedBuilds = computed(() => devops.builds);

const queueActive = computed(() => {
  const runId = devops.queue.running ? devops.queue.currentBuildId : null;
  const running = devops.builds.filter((b) => b.status === "running");
  const queued = devops.queue.queuedIds
    .map((id) => devops.builds.find((b) => b.id === id))
    .filter((b): b is BuildJob => Boolean(b))
    .filter((b) => b.id !== runId);
  const seen = new Set<string>();
  const out: BuildJob[] = [];
  for (const j of running) {
    if (!seen.has(j.id)) {
      seen.add(j.id);
      out.push(j);
    }
  }
  for (const j of queued) {
    if (!seen.has(j.id)) {
      seen.add(j.id);
      out.push(j);
    }
  }
  return out;
});

function linesForJob(job: BuildJob): BuildLogLine[] {
  if (job.id === devops.liveBuildId && devops.logLines.length) {
    return devops.logLines;
  }
  if (job.id === devops.viewingBuildId && devops.viewLogLines.length) {
    return devops.viewLogLines;
  }
  return logCache.value[job.id] || [];
}

async function ensureCardLogs(job: BuildJob) {
  if (job.status === "running") {
    await devops.selectBuild(job.id);
    return;
  }
  if (logCache.value[job.id]?.length) {
    await devops.selectBuildJob(job);
    return;
  }
  await devops.selectBuildJob(job);
  if (devops.viewLogLines.length) {
    logCache.value = {
      ...logCache.value,
      [job.id]: [...devops.viewLogLines],
    };
  }
}

async function toggleBuildCard(job: BuildJob) {
  if (expandedBuildId.value === job.id) {
    expandedBuildId.value = null;
    return;
  }
  expandedBuildId.value = job.id;
  await ensureCardLogs(job);
}

function copyCommand(job: BuildJob) {
  void navigator.clipboard?.writeText(job.command).then(() => {
    message.success("Command copied");
  });
}

async function onCancelCard(job: BuildJob) {
  await onCancel(job.id);
}

const formTitle = computed(() =>
  editingId.value ? "Edit script" : "Add build script",
);

const liveRunning = computed(() => devops.liveBuild?.status === "running");

const selectedRunning = computed(() => devops.selected?.status === "running");

const histStatusOptions = [
  { value: "", label: "All" },
  { value: "success", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "timeout", label: "Timeout" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
];

const histStatusModel = computed({
  get: () => devops.historyStatus ?? "",
  set: (v: string) => {
    void devops.setHistoryStatus((v || undefined) as BuildStatus | undefined);
  },
});

const histColumns = [
  { title: "Started", key: "start", width: 150 },
  { title: "Script", key: "script" },
  { title: "Status", key: "status", width: 110 },
  { title: "Duration", key: "duration", width: 100 },
  { title: "Triggered by", key: "by", width: 130 },
  { title: "Exit", key: "exit", width: 60 },
  { title: "", key: "actions", width: 90 },
];

const scriptColumns = computed(() => {
  if (configCompact.value) {
    return [
      { title: "", key: "active", width: 44 },
      { title: "Build script", key: "script" },
      { title: "", key: "actions", width: 84 },
    ];
  }
  return [
    { title: "", key: "active", width: 52 },
    { title: "Name", key: "label", width: 130 },
    { title: "Command", key: "command" },
    { title: "cwd", key: "cwd", width: 120 },
    { title: "T/o", key: "timeout", width: 52 },
    { title: "", key: "actions", width: 96 },
  ];
});

function formatMs(ms: number) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDuration(job: BuildJob) {
  const ms = job.durationMs;
  if (ms == null) {
    if (job.status === "running" && job.startedAt) {
      void nowTick.value;
      const t = Date.parse(job.startedAt);
      if (!Number.isFinite(t)) return "—";
      return formatMs(Date.now() - t);
    }
    return "—";
  }
  return formatMs(ms);
}

function formatTime(iso?: string) {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString("en-US", { hour12: false });
}

function statusClass(status: BuildStatus) {
  switch (status) {
    case "queued":
      return "faw-dev-badge faw-dev-badge--queued";
    case "running":
      return "faw-dev-badge faw-dev-badge--run";
    case "success":
      return "faw-dev-badge faw-dev-badge--ok";
    case "failed":
    case "timeout":
      return "faw-dev-badge faw-dev-badge--err";
    default:
      return "faw-dev-badge faw-dev-badge--warn";
  }
}

function resetForm() {
  editingId.value = null;
  form.id = "";
  form.label = "";
  form.command = "";
  form.workingDir = "";
  form.timeoutSec = undefined;
}

function openCreate() {
  resetForm();
  formOpen.value = true;
}

function openEdit(s: BuildScript) {
  editingId.value = s.id;
  form.id = s.id;
  form.label = s.label;
  form.command = s.command;
  form.workingDir = s.workingDir;
  form.timeoutSec = s.timeoutSec;
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  resetForm();
}

async function onSaveScript() {
  if (!canConfigure.value) {
    message.error("Only the devops role can configure scripts");
    return Promise.reject(new Error("forbidden"));
  }
  if (!form.label.trim() || !form.command.trim() || !form.workingDir.trim()) {
    message.error("Please fill in Name, Command, and Working dir");
    return Promise.reject(new Error("validation"));
  }
  try {
    await devops.saveScript({
      id: editingId.value || form.id.trim() || undefined,
      label: form.label.trim(),
      command: form.command.trim(),
      workingDir: form.workingDir.trim(),
      timeoutSec: form.timeoutSec,
    });
    message.success(editingId.value ? "Script updated" : "Script added");
    closeForm();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
    return Promise.reject(e);
  }
}

async function onDeleteScript(id: string) {
  if (!canConfigure.value) {
    message.error("Only the devops role can configure scripts");
    return;
  }
  try {
    await devops.removeScript(id);
    if (editingId.value === id) closeForm();
    message.success("Script deleted");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onToggleScript(s: BuildScript, active: boolean) {
  if (!canConfigure.value) {
    message.error("Only the devops role can configure scripts");
    return;
  }
  try {
    await devops.toggleScript(s.id, active);
    message.success(active ? `Enabled «${s.label}»` : `Disabled «${s.label}»`);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

/** Jobs of this script still queued or running. */
function queuedCount(scriptId: string) {
  return scriptBusyCount(scriptId);
}

async function doTrigger(scriptId: string) {
  try {
    const job = await devops.trigger(scriptId);
    message.success("Build queued");
    devops.activeTab = "build";
    expandedBuildId.value = job.id;
    await ensureCardLogs(job);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

function onRun(s: BuildScript) {
  const queued = queuedCount(s.id);
  if (queued > 0) {
    dupConfirm.script = s;
    dupConfirm.queued = queued;
    dupConfirm.open = true;
    return;
  }
  void doTrigger(s.id);
}

async function confirmDupRun() {
  const s = dupConfirm.script;
  dupConfirm.open = false;
  if (s) await doTrigger(s.id);
}

async function onCancel(id: string) {
  try {
    await devops.cancel(id);
    message.success("Cancel requested");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function openHistoryJob(job: BuildJob) {
  await devops.selectBuildJob(job);
  histDrawerOpen.value = true;
}

async function onSendStdin() {
  const job = devops.liveBuild;
  if (!job || job.status !== "running") return;
  try {
    await devops.sendStdin(job.id, stdinText.value, stdinSecret.value);
    stdinText.value = "";
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onDownloadLog(job?: BuildJob | null) {
  const target = job ?? devops.liveBuild ?? devops.selected;
  if (!target) return;
  try {
    const res = await devopsApi.log(target.id);
    const blob = new Blob([res.text || ""], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${target.scriptId}-${target.id}.log`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

function onHistPageChange(page: number) {
  void devops.fetchHistory(page);
}

watch(
  () => devops.logLines,
  (lines) => {
    const id = devops.liveBuildId;
    if (!id || !lines.length) return;
    logCache.value = { ...logCache.value, [id]: [...lines] };
  },
  { deep: true },
);

watch(
  () => devops.liveBuild,
  (job) => {
    if (!job || job.status !== "failed") return;
    if (lastFailedToastId.value === job.id) return;
    lastFailedToastId.value = job.id;
    message.error(job.errorMessage?.trim() || "Build failed", 8);
  },
);

watch(
  () => devops.activeTab,
  (tab) => {
    if (tab === "history" && !devops.history.length) {
      void devops.fetchHistory(1).catch(() => undefined);
    }
    if (tab === "build") {
      void devops.syncLiveStream();
    }
  },
);

let configMq: MediaQueryList | undefined;
let syncConfigCompact: (() => void) | undefined;

onMounted(async () => {
  configMq = window.matchMedia("(max-width: 1023px)");
  syncConfigCompact = () => {
    configCompact.value = configMq!.matches;
  };
  syncConfigCompact();
  configMq.addEventListener("change", syncConfigCompact);

  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
  try {
    await devops.refresh();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
  devops.connectEvents();
  const current =
    devops.queue.currentBuildId ||
    devops.builds.find((b) => b.status === "running")?.id ||
    devops.builds[0]?.id;
  if (current) {
    expandedBuildId.value = current;
    const job = devops.builds.find((b) => b.id === current);
    if (job) await ensureCardLogs(job);
  }
});

onUnmounted(() => {
  if (configMq && syncConfigCompact) {
    configMq.removeEventListener("change", syncConfigCompact);
  }
  if (tickTimer) clearInterval(tickTimer);
  devops.disconnect();
});
</script>

<template>
  <div class="faw-dev-dash">
    <!-- Tab 1: Build -->
    <div v-if="devops.activeTab === 'build'" class="faw-build-shell">
      <!-- Sidebar: scripts -->
      <aside
        class="faw-build-sidebar"
        :class="{ 'is-collapsed': scriptsCollapsed }"
      >
        <div class="faw-build-sidebar__head">
          <button
            type="button"
            class="faw-build-sidebar__title-row w-full text-left lg:pointer-events-none"
            @click="scriptsCollapsed = !scriptsCollapsed"
          >
            <span class="faw-build-sidebar__title">Scripts</span>
            <span class="faw-build-sidebar__count">{{ activeScripts.length }}</span>
            <span class="lg:hidden ml-auto text-[11px] text-[var(--ink-muted)]">
              {{ scriptsCollapsed ? "Show" : "Hide" }}
            </span>
          </button>
          <div class="faw-build-search">
            <SearchOutlined class="faw-build-search__icon" />
            <input
              v-model="scriptSearch"
              type="search"
              class="faw-build-search__input"
              placeholder="Search scripts…"
            />
          </div>
        </div>

        <div class="faw-build-script-list">
          <div v-if="devops.loading" class="faw-build-empty">Loading scripts…</div>
          <div
            v-else-if="!activeScripts.length"
            class="faw-build-empty"
          >
            <template v-if="canConfigure">
              No active scripts. Open the
              <strong>Config</strong> tab to add or enable one.
            </template>
            <template v-else>
              No active scripts. Ask devops to configure scripts.
            </template>
          </div>
          <div
            v-else-if="!filteredScripts.length"
            class="faw-build-empty"
          >
            No matching scripts.
          </div>
          <template v-else>
            <div
              v-for="s in filteredScripts"
              :key="s.id"
              class="faw-build-script-row"
              :class="{ 'is-running': scriptQueueState(s.id).running > 0 }"
            >
              <div class="faw-build-script-row__swatch" />
              <div class="faw-build-script-row__body">
                <div class="faw-build-script-row__name">{{ s.label }}</div>
                <div class="faw-build-script-row__cmd">{{ s.command }}</div>
              </div>
              <button
                type="button"
                class="faw-build-run-btn"
                :class="{
                  'is-disabled':
                    scriptQueueState(s.id).running > 0 ||
                    devops.triggeringId === s.id ||
                    devops.queue.shuttingDown,
                }"
                :disabled="
                  scriptQueueState(s.id).running > 0 ||
                  devops.triggeringId === s.id ||
                  devops.queue.shuttingDown
                "
                @click="onRun(s)"
              >
                <span class="faw-build-run-btn__icon">▶</span>
                {{
                  scriptQueueState(s.id).running > 0
                    ? "Running"
                    : devops.triggeringId === s.id
                      ? "…"
                      : "Run"
                }}
              </button>
            </div>
          </template>
        </div>
      </aside>

      <!-- Main: queue + feed -->
      <div class="faw-build-main">
        <section class="faw-build-queue-strip">
          <div class="faw-build-queue-strip__title">
            Build queue
            <span class="faw-build-queue-strip__n">({{ queueActive.length }})</span>
          </div>
          <div v-if="!queueActive.length" class="faw-build-queue-empty">
            No builds waiting — FIFO, at most one build at a time.
          </div>
          <div v-else class="faw-build-queue-chips">
            <template v-for="(job, idx) in queueActive" :key="job.id">
              <button
                type="button"
                class="faw-build-chip"
                :class="{ 'is-running': job.status === 'running' }"
                @click="toggleBuildCard(job)"
              >
                <span class="faw-build-chip__pos">
                  {{ job.status === "running" ? "●" : `#${idx + 1}` }}
                </span>
                <span class="faw-build-chip__name">{{ job.scriptLabel }}</span>
              </button>
              <span
                v-if="idx < queueActive.length - 1"
                class="faw-build-chip__arrow"
              >→</span>
            </template>
          </div>
        </section>

        <div class="faw-build-feed">
          <div v-if="!feedBuilds.length" class="faw-build-feed-empty">
            No builds yet. Pick a script on the left to start.
          </div>
          <BuildFeedCard
            v-for="job in feedBuilds"
            :key="job.id"
            :job="job"
            :open="expandedBuildId === job.id"
            :lines="linesForJob(job)"
            :now-ms="nowTick"
            @toggle="toggleBuildCard(job)"
            @copy="copyCommand(job)"
            @download="onDownloadLog(job)"
            @cancel="onCancelCard(job)"
          />

          <form
            v-if="
              expandedBuildId &&
              devops.liveBuild?.status === 'running' &&
              expandedBuildId === devops.liveBuildId
            "
            class="faw-build-stdin"
            @submit.prevent="onSendStdin"
          >
            <input
              v-model="stdinText"
              class="faw-build-stdin__input"
              :type="stdinSecret ? 'password' : 'text'"
              :disabled="!liveRunning || devops.stdinBusy"
              placeholder="Send text/password to stdin (running build)…"
              autocomplete="off"
            />
            <label class="faw-build-stdin__secret">
              <input v-model="stdinSecret" type="checkbox" />
              Password
            </label>
            <button
              type="submit"
              class="faw-build-run-btn faw-build-stdin__send"
              :disabled="!liveRunning || devops.stdinBusy"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>

    <!-- Tab 2: History -->
    <div v-else-if="devops.activeTab === 'history'" class="faw-dev-full faw-col">
      <div class="faw-col-head">
        <h2>History</h2>
        <span class="faw-count">{{ devops.historyTotal }} builds</span>
        <span class="flex-1" />
        <a-select
          v-model:value="histStatusModel"
          class="w-36"
          size="small"
          :options="histStatusOptions"
        />
      </div>
      <a-table
        class="faw-dev-hist-table"
        :columns="histColumns"
        :data-source="devops.history"
        :loading="devops.historyLoading"
        row-key="id"
        size="small"
        :scroll="{ x: 720 }"
        :pagination="{
          current: devops.historyPage,
          pageSize: devops.historyPageSize,
          total: devops.historyTotal,
          showSizeChanger: false,
        }"
        :custom-row="
          (record: BuildJob) => ({
            onClick: () => openHistoryJob(record),
          })
        "
        @change="(p: { current?: number }) => onHistPageChange(p.current || 1)"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'start'">
            <span class="font-mono text-[12px]">
              {{ formatTime((record as BuildJob).startedAt || (record as BuildJob).queuedAt) }}
            </span>
          </template>
          <template v-else-if="column.key === 'script'">
            <div class="min-w-0">
              <div class="faw-task-row__title truncate">
                {{ (record as BuildJob).scriptLabel }}
              </div>
              <div class="faw-dev-script-row__cmd truncate">
                {{ (record as BuildJob).command }}
              </div>
            </div>
          </template>
          <template v-else-if="column.key === 'status'">
            <span :class="statusClass((record as BuildJob).status)">
              {{ (record as BuildJob).status }}
            </span>
          </template>
          <template v-else-if="column.key === 'duration'">
            {{ formatDuration(record as BuildJob) }}
          </template>
          <template v-else-if="column.key === 'by'">
            {{ (record as BuildJob).triggeredBy }}
          </template>
          <template v-else-if="column.key === 'exit'">
            {{ (record as BuildJob).exitCode ?? "—" }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <button
              type="button"
              class="faw-btn faw-btn--tight"
              @click.stop="openHistoryJob(record as BuildJob)"
            >
              Log
            </button>
          </template>
        </template>
      </a-table>
    </div>

    <!-- Tab 3: Config (devops / admin only) -->
    <div v-else-if="canConfigure" class="faw-dev-full faw-col">
      <div class="faw-col-head">
        <h2>Config</h2>
        <span class="faw-count">{{ devops.scripts.length }}</span>
        <span class="flex-1" />
        <button
          type="button"
          class="faw-btn faw-btn--run faw-btn--tight"
          @click="openCreate"
        >
          + Add script
        </button>
      </div>

      <div class="faw-dev-config-body">
        <a-table
          class="faw-dev-script-table"
          :columns="scriptColumns"
          :data-source="devops.scripts"
          :loading="devops.loading"
          row-key="id"
          size="small"
          :pagination="false"
          :scroll="configCompact ? { x: 360 } : undefined"
        >
          <template #emptyText>
            <span class="text-xs text-ink-muted">
              No scripts yet — click «+ Add script».
            </span>
          </template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'active'">
              <a-switch
                :checked="(record as BuildScript).active !== false"
                size="small"
                @change="(v: boolean) => onToggleScript(record as BuildScript, v)"
              />
            </template>
            <template v-else-if="column.key === 'script'">
              <div class="min-w-0" :class="{ 'opacity-60': (record as BuildScript).active === false }">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="faw-task-row__title truncate">
                    {{ (record as BuildScript).label }}
                  </span>
                  <span
                    v-if="(record as BuildScript).active === false"
                    class="faw-chip shrink-0"
                  >
                    off
                  </span>
                </div>
                <div class="faw-dev-script-row__cmd truncate">
                  {{ (record as BuildScript).command }}
                </div>
                <div class="faw-dev-script-row__cmd truncate lg:hidden">
                  cwd {{ (record as BuildScript).workingDir }}
                  <span v-if="(record as BuildScript).timeoutSec">
                    · {{ (record as BuildScript).timeoutSec }}s
                  </span>
                </div>
              </div>
            </template>
            <template v-else-if="column.key === 'label'">
              <div class="min-w-0" :class="{ 'opacity-60': (record as BuildScript).active === false }">
                <div class="faw-task-row__title truncate">
                  {{ (record as BuildScript).label }}
                </div>
                <div class="faw-dev-script-row__cmd truncate">
                  {{ (record as BuildScript).id }}
                </div>
              </div>
            </template>
            <template v-else-if="column.key === 'command'">
              <span
                class="faw-dev-script-row__cmd truncate block"
                :class="{ 'opacity-60': (record as BuildScript).active === false }"
              >
                {{ (record as BuildScript).command }}
              </span>
            </template>
            <template v-else-if="column.key === 'cwd'">
              <span class="faw-dev-script-row__cmd truncate block">
                {{ (record as BuildScript).workingDir }}
              </span>
            </template>
            <template v-else-if="column.key === 'timeout'">
              <span class="font-mono text-[11px] text-ink-muted">
                {{ (record as BuildScript).timeoutSec ?? "—" }}
              </span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <div class="flex items-center gap-1 justify-end">
                <button
                  type="button"
                  class="faw-btn faw-btn--tight"
                  @click="openEdit(record as BuildScript)"
                >
                  Edit
                </button>
                <a-popconfirm
                  title="Delete this script?"
                  ok-text="Delete"
                  cancel-text="Keep"
                  ok-type="danger"
                  @confirm="onDeleteScript((record as BuildScript).id)"
                >
                  <button
                    type="button"
                    class="faw-btn faw-btn--danger faw-btn--tight"
                    :disabled="devops.deletingScriptId === (record as BuildScript).id"
                  >
                    Delete
                  </button>
                </a-popconfirm>
              </div>
            </template>
          </template>
        </a-table>
      </div>
    </div>

    <!-- History detail drawer -->
    <a-drawer
      v-model:open="histDrawerOpen"
      :title="devops.selected?.scriptLabel || 'Build log'"
      placement="right"
      :width="720"
    >
      <div v-if="devops.selected" class="flex flex-col gap-3 h-full min-h-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span :class="statusClass(devops.selected.status)">
            {{ devops.selected.status }}
          </span>
          <span class="text-xs text-ink-muted">
            Started {{ formatTime(devops.selected.startedAt || devops.selected.queuedAt) }}
          </span>
          <span class="text-xs text-ink-muted">
            · {{ formatDuration(devops.selected) }}
          </span>
          <span class="text-xs text-ink-muted">
            · {{ devops.selected.triggeredBy }}
          </span>
          <span class="flex-1" />
          <a-popconfirm
            v-if="selectedRunning"
            title="Stop the running build?"
            ok-text="Cancel Build"
            cancel-text="Keep"
            ok-type="danger"
            @confirm="onCancel(devops.selectedId!)"
          >
            <button type="button" class="faw-btn faw-btn--danger faw-btn--tight">
              Cancel
            </button>
          </a-popconfirm>
          <button
            type="button"
            class="faw-btn faw-btn--tight"
            @click="onDownloadLog(devops.selected)"
          >
            Download
          </button>
        </div>
        <div class="text-[11px] font-mono text-ink-muted break-all">
          $ {{ devops.selected.command }}
          <span class="text-ink-faint"> (cwd {{ devops.selected.workingDir }})</span>
        </div>
        <p
          v-if="devops.selected.errorMessage"
          class="m-0 text-xs text-red-500"
        >
          {{ devops.selected.errorMessage }}
        </p>
        <div class="faw-dev-drawer-term">
          <BuildTerminal
            :lines="devops.viewLogLines"
            :build-id="devops.viewingBuildId"
          />
        </div>
      </div>
    </a-drawer>

    <!-- Script create/edit modal -->
    <a-modal
      v-if="canConfigure"
      v-model:open="formOpen"
      :title="formTitle"
      ok-text="Save"
      cancel-text="Cancel"
      :confirm-loading="devops.savingScript"
      :width="560"
      wrap-class-name="work-modal-sheet"
      :centered="false"
      destroy-on-close
      @ok="onSaveScript"
      @cancel="closeForm"
    >
      <a-form layout="vertical" class="mt-1">
        <a-form-item label="Name" required>
          <a-input v-model:value="form.label" placeholder="Deploy UAT" />
        </a-form-item>
        <a-form-item v-if="!editingId" label="Id (optional)">
          <a-input
            v-model:value="form.id"
            class="font-mono"
            placeholder="deploy-uat — leave blank to slug from name"
          />
        </a-form-item>
        <a-form-item label="Command" required>
          <a-input
            v-model:value="form.command"
            class="font-mono"
            placeholder="bash /opt/build/YKKUAT.sh"
          />
        </a-form-item>
        <a-form-item label="Working dir" required>
          <a-input
            v-model:value="form.workingDir"
            class="font-mono"
            placeholder="/opt/build or ~/projects/ykk"
          />
        </a-form-item>
        <a-form-item label="Timeout (seconds)">
          <a-input-number
            v-model:value="form.timeoutSec"
            class="w-full"
            :min="1"
            :max="86400"
            placeholder="1800"
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- Duplicate-run confirm -->
    <a-modal
      v-model:open="dupConfirm.open"
      title="Script already in the queue"
      ok-text="Queue anyway"
      cancel-text="Cancel"
      @ok="confirmDupRun"
    >
      <p class="text-sm">
        «{{ dupConfirm.script?.label }}» already has
        <strong>{{ dupConfirm.queued }}</strong>
        job(s) queued or running.
      </p>
      <p class="text-sm text-ink-muted">
        Queue another run? (FIFO — the new job runs after the current ones.)
      </p>
    </a-modal>
  </div>
</template>
