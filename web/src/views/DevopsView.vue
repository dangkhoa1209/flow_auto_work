<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { devopsApi } from "@/api/devopsApi";
import type { BuildJob, BuildScript, BuildStatus } from "@/api/devopsApi";
import BuildTerminal from "@/components/devops/BuildTerminal.vue";
import { useDevopsStore } from "@/stores/devops";

const devops = useDevopsStore();
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
const termRef = ref<{ clear: () => void } | null>(null);
const testBusy = ref(false);

/** Confirm re-run when the same script already has a queued/running job. */
const dupConfirm = reactive({
  open: false,
  script: null as BuildScript | null,
  queued: 0,
});

const TEST_SCRIPT_ID = "test-queue-20s";

const form = reactive({
  id: "",
  label: "",
  command: "",
  workingDir: "",
  timeoutSec: undefined as number | undefined,
});

const runningJob = computed(
  () => devops.builds.find((b) => b.id === devops.queue.currentBuildId) || null,
);

const queuedJobs = computed(() =>
  devops.queue.queuedIds
    .map((id, i) => ({
      pos: i + 1,
      job: devops.builds.find((b) => b.id === id),
    }))
    .filter((row): row is { pos: number; job: BuildJob } => Boolean(row.job)),
);

const activeScripts = computed(() =>
  devops.scripts.filter((s) => s.active !== false),
);

const formTitle = computed(() =>
  editingId.value ? "Sửa lệnh" : "Thêm lệnh build",
);

const liveRunning = computed(() => devops.liveBuild?.status === "running");

const liveClock = computed(() => {
  void nowTick.value;
  const job = devops.liveBuild;
  if (!job) return "00:00:00";
  if (job.status === "running" && job.startedAt) {
    const t = Date.parse(job.startedAt);
    if (!Number.isFinite(t)) return "00:00:00";
    return formatClock(Date.now() - t);
  }
  if (job.durationMs != null) return formatClock(job.durationMs);
  return "00:00:00";
});

const selectedRunning = computed(() => devops.selected?.status === "running");

const histStatusOptions = [
  { value: "", label: "Tất cả" },
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
  { title: "Bắt đầu", key: "start", width: 150 },
  { title: "Script", key: "script" },
  { title: "Trạng thái", key: "status", width: 110 },
  { title: "Thời gian", key: "duration", width: 100 },
  { title: "Người chạy", key: "by", width: 130 },
  { title: "Exit", key: "exit", width: 60 },
  { title: "", key: "actions", width: 90 },
];

const scriptColumns = computed(() => {
  if (configCompact.value) {
    return [
      { title: "", key: "active", width: 44 },
      { title: "Lệnh build", key: "script" },
      { title: "", key: "actions", width: 84 },
    ];
  }
  return [
    { title: "", key: "active", width: 52 },
    { title: "Tên", key: "label", width: 130 },
    { title: "Command", key: "command" },
    { title: "cwd", key: "cwd", width: 120 },
    { title: "T/o", key: "timeout", width: 52 },
    { title: "", key: "actions", width: 96 },
  ];
});

function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

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
  return t.toLocaleString("vi-VN", { hour12: false });
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
  if (!form.label.trim() || !form.command.trim() || !form.workingDir.trim()) {
    message.error("Vui lòng điền đủ Tên, Lệnh và Working dir");
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
    message.success(editingId.value ? "Đã cập nhật lệnh" : "Đã thêm lệnh");
    closeForm();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
    return Promise.reject(e);
  }
}

async function onDeleteScript(id: string) {
  try {
    await devops.removeScript(id);
    if (editingId.value === id) closeForm();
    message.success("Đã xóa lệnh");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onToggleScript(s: BuildScript, active: boolean) {
  try {
    await devops.toggleScript(s.id, active);
    message.success(active ? `Đã bật «${s.label}»` : `Đã tắt «${s.label}»`);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

/** Jobs of this script still queued or running. */
function queuedCount(scriptId: string) {
  const queuedOfScript = queuedJobs.value.filter(
    (r) => r.job.scriptId === scriptId,
  ).length;
  const runningOfScript =
    runningJob.value?.scriptId === scriptId ? 1 : 0;
  return queuedOfScript + runningOfScript;
}

async function doTrigger(scriptId: string) {
  try {
    await devops.trigger(scriptId);
    message.success("Build queued");
    devops.activeTab = "build";
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

/** Seed (if needed) + trigger a 20s dummy build to test the FIFO queue. */
async function onRunTest20s() {
  if (testBusy.value) return;
  testBusy.value = true;
  try {
    if (!devops.scripts.some((s) => s.id === TEST_SCRIPT_ID)) {
      await devops.saveScript({
        id: TEST_SCRIPT_ID,
        label: "Test queue (20s)",
        command:
          'for i in $(seq 1 20); do echo "tick $i/20"; sleep 1; done',
        workingDir: "~",
        timeoutSec: 120,
      });
    }
    await doTrigger(TEST_SCRIPT_ID);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    testBusy.value = false;
  }
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

function onClearLog() {
  termRef.value?.clear();
}

function onHistPageChange(page: number) {
  void devops.fetchHistory(page);
}

watch(
  () => devops.activeTab,
  (tab) => {
    if (tab === "history" && !devops.history.length) {
      void devops.fetchHistory(1).catch(() => undefined);
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
  if (current) await devops.selectBuild(current);
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
    <!-- Tab 1: Build (tabs + worker/queue live in DevopsLayout header) -->
    <div v-if="devops.activeTab === 'build'" class="faw-dev-body">
      <section class="faw-dev-left faw-col flex flex-col min-h-0 overflow-hidden">
        <div class="faw-col-head">
          <h2>Scripts</h2>
          <span class="faw-count">{{ activeScripts.length }}</span>
        </div>

        <div class="faw-filters">
          <div class="faw-filters__row">
            <button
              type="button"
              class="faw-btn"
              style="flex: 1"
              :disabled="testBusy || devops.queue.shuttingDown"
              @click="onRunTest20s"
            >
              {{ testBusy ? "Đang tạo…" : "⏱ Test queue (20s)" }}
            </button>
          </div>
        </div>

        <div class="faw-list-scroll flex-1 min-h-0">
          <div v-if="devops.loading" class="px-3 py-2 text-xs text-ink-muted">
            Loading scripts…
          </div>
          <div
            v-else-if="!activeScripts.length"
            class="px-3 py-4 text-xs text-ink-muted leading-relaxed"
          >
            Chưa có lệnh nào active. Sang tab
            <strong class="text-ink font-semibold">Cấu hình</strong>
            để thêm hoặc bật lệnh.
          </div>
          <template v-else>
            <div class="faw-group-label">
              Active <span class="n">{{ activeScripts.length }}</span>
            </div>
            <div
              v-for="s in activeScripts"
              :key="s.id"
              class="faw-dev-script-row"
            >
              <div class="min-w-0 flex-1">
                <div class="faw-task-row__title">{{ s.label }}</div>
                <div class="faw-dev-script-row__cmd truncate">
                  {{ s.command }}
                </div>
              </div>
              <span
                v-if="queuedCount(s.id) > 0"
                class="faw-chip shrink-0"
                title="Job của lệnh này đang trong queue / đang chạy"
              >
                {{ queuedCount(s.id) }} queued
              </span>
              <button
                type="button"
                class="faw-btn faw-btn--run faw-btn--tight shrink-0"
                :disabled="
                  devops.triggeringId === s.id || devops.queue.shuttingDown
                "
                @click="onRun(s)"
              >
                {{ devops.triggeringId === s.id ? "…" : "▶ Run" }}
              </button>
            </div>
          </template>
        </div>
      </section>

      <section class="faw-dev-right">
        <div class="faw-dev-term-head">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 min-w-0">
              <h2 class="faw-dev-term-head__title truncate">
                {{ devops.liveBuild?.scriptLabel || "Live terminal" }}
              </h2>
              <span
                v-if="devops.liveBuild"
                :class="statusClass(devops.liveBuild.status)"
              >
                {{ devops.liveBuild.status }}
              </span>
            </div>
            <p class="faw-dev-term-head__sub truncate">
              {{ devops.liveBuild?.command || "Chọn một build để xem log" }}
            </p>
          </div>
          <div class="faw-dev-term-actions">
            <span class="faw-dev-clock font-mono">{{ liveClock }}</span>
            <a-popconfirm
              v-if="liveRunning"
              title="Dừng khẩn cấp build đang chạy?"
              ok-text="Cancel Build"
              cancel-text="Giữ"
              ok-type="danger"
              @confirm="onCancel(devops.liveBuildId!)"
            >
              <button
                type="button"
                class="faw-btn faw-btn--danger faw-btn--tight"
                :disabled="devops.cancellingId === devops.liveBuildId"
              >
                Cancel
              </button>
            </a-popconfirm>
            <button type="button" class="faw-btn faw-btn--tight" @click="onClearLog">
              Clear
            </button>
            <button
              type="button"
              class="faw-btn faw-btn--tight"
              :disabled="!devops.liveBuild"
              @click="onDownloadLog"
            >
              Download
            </button>
          </div>
        </div>

        <BuildTerminal
          :key="devops.liveBuildId ?? 'idle'"
          ref="termRef"
          :lines="devops.logLines"
          :build-id="devops.liveBuildId"
        />

        <form class="faw-dev-stdin" @submit.prevent="onSendStdin">
          <input
            v-model="stdinText"
            class="faw-dev-stdin__input"
            :type="stdinSecret ? 'password' : 'text'"
            :disabled="!liveRunning || devops.stdinBusy"
            :placeholder="
              liveRunning
                ? 'Gửi text/password vào stdin…'
                : 'Stdin chỉ khi build đang RUNNING'
            "
            autocomplete="off"
          />
          <label class="faw-dev-stdin__secret">
            <input v-model="stdinSecret" type="checkbox" />
            Password
          </label>
          <button
            type="submit"
            class="faw-btn faw-btn--run faw-btn--tight"
            :disabled="!liveRunning || devops.stdinBusy"
          >
            Send
          </button>
        </form>
      </section>
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

    <!-- Tab 3: Cấu hình -->
    <div v-else class="faw-dev-full faw-col">
      <div class="faw-col-head">
        <h2>Cấu hình</h2>
        <span class="faw-count">{{ devops.scripts.length }}</span>
        <span class="flex-1" />
        <button
          type="button"
          class="faw-btn faw-btn--run faw-btn--tight"
          @click="openCreate"
        >
          + Thêm lệnh
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
              Chưa có lệnh nào — bấm «+ Thêm lệnh».
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
                  Sửa
                </button>
                <a-popconfirm
                  title="Xóa lệnh này?"
                  ok-text="Xóa"
                  cancel-text="Giữ"
                  ok-type="danger"
                  @confirm="onDeleteScript((record as BuildScript).id)"
                >
                  <button
                    type="button"
                    class="faw-btn faw-btn--danger faw-btn--tight"
                    :disabled="devops.deletingScriptId === (record as BuildScript).id"
                  >
                    Xóa
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
            Bắt đầu {{ formatTime(devops.selected.startedAt || devops.selected.queuedAt) }}
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
            title="Dừng build đang chạy?"
            ok-text="Cancel Build"
            cancel-text="Giữ"
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
            :lines="devops.logLines"
            :build-id="devops.selectedId"
          />
        </div>
      </div>
    </a-drawer>

    <!-- Script create/edit modal -->
    <a-modal
      v-model:open="formOpen"
      :title="formTitle"
      ok-text="Lưu"
      cancel-text="Hủy"
      :confirm-loading="devops.savingScript"
      :width="560"
      wrap-class-name="work-modal-sheet"
      :centered="false"
      destroy-on-close
      @ok="onSaveScript"
      @cancel="closeForm"
    >
      <a-form layout="vertical" class="mt-1">
        <a-form-item label="Tên" required>
          <a-input v-model:value="form.label" placeholder="Deploy UAT" />
        </a-form-item>
        <a-form-item v-if="!editingId" label="Id (optional)">
          <a-input
            v-model:value="form.id"
            class="font-mono"
            placeholder="deploy-uat — để trống sẽ slug từ tên"
          />
        </a-form-item>
        <a-form-item label="Lệnh" required>
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
            placeholder="/opt/build hoặc ~/projects/ykk"
          />
        </a-form-item>
        <a-form-item label="Timeout (giây)">
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
      title="Lệnh đang có trong queue"
      ok-text="Vẫn chạy"
      cancel-text="Bỏ qua"
      @ok="confirmDupRun"
    >
      <p class="text-sm">
        «{{ dupConfirm.script?.label }}» đang có
        <strong>{{ dupConfirm.queued }}</strong>
        job trong queue / đang chạy.
      </p>
      <p class="text-sm text-ink-muted">
        Có muốn xếp thêm một lần chạy nữa không? (FIFO — job mới sẽ chạy sau)
      </p>
    </a-modal>
  </div>
</template>
