<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import { useAutoScroll } from "@/composables/useAutoScroll";
import { useDevopsStore } from "@/stores/devops";
import type { BuildJob, BuildScript, BuildStatus } from "@/api/devopsApi";

const devops = useDevopsStore();
const logBox = ref<HTMLElement | null>(null);
const scroll = useAutoScroll(logBox, () => devops.logLines.length);
const nowTick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | undefined;

const formOpen = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({
  id: "",
  label: "",
  command: "",
  workingDir: "",
  timeoutSec: undefined as number | undefined,
});

const queueHint = computed(() => {
  const q = devops.queue;
  if (q.shuttingDown) return "Server is shutting down";
  if (q.running) {
    const extra = q.queued > 0 ? ` · ${q.queued} waiting` : "";
    return `Running 1 job (FIFO, concurrency 1)${extra}`;
  }
  if (q.queued > 0) return `${q.queued} waiting in queue`;
  return "Idle — queue empty";
});

const idleDot = computed(() => (devops.queue.running ? "wip" : "idle"));
const formTitle = computed(() =>
  editingId.value ? "Sửa lệnh" : "Thêm lệnh build",
);

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
  try {
    await devops.saveScript({
      id: editingId.value || form.id.trim() || undefined,
      label: form.label,
      command: form.command,
      workingDir: form.workingDir,
      timeoutSec: form.timeoutSec,
    });
    message.success(editingId.value ? "Đã cập nhật lệnh" : "Đã thêm lệnh");
    closeForm();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
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

function statusClass(status: BuildStatus) {
  switch (status) {
    case "queued":
      return "bg-blue-500/15 text-blue-400";
    case "running":
      return "bg-blue-500/20 text-blue-300";
    case "success":
      return "bg-emerald-500/15 text-emerald-400";
    case "failed":
      return "bg-red-500/15 text-red-400";
    case "timeout":
      return "bg-orange-500/15 text-orange-400";
    default:
      return "bg-zinc-500/15 text-zinc-400";
  }
}

function formatDuration(job: BuildJob) {
  const ms = job.durationMs;
  if (ms == null) {
    if (job.status === "running" && job.startedAt) {
      void nowTick.value;
      return elapsed(Date.parse(job.startedAt));
    }
    return "—";
  }
  return formatMs(ms);
}

function elapsed(startedMs: number) {
  if (!Number.isFinite(startedMs)) return "—";
  return formatMs(Math.max(0, Date.now() - startedMs));
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

function logColor(stream: string) {
  if (stream === "stderr") return "text-red-400";
  if (stream === "system") return "text-sky-400";
  return "text-zinc-200";
}

function canCancel(job: BuildJob) {
  return job.status === "queued" || job.status === "running";
}

async function onTrigger(scriptId: string) {
  try {
    await devops.trigger(scriptId);
    message.success("Build queued");
    scroll.resetPin();
    await scroll.scrollToBottom(true);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
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

async function onSelect(id: string) {
  await devops.selectBuild(id);
  scroll.resetPin();
  await scroll.scrollToBottom(true);
}

onMounted(async () => {
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
  try {
    await devops.refresh();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
  devops.connectEvents();
  const current = devops.queue.currentBuildId || devops.builds[0]?.id;
  if (current) await devops.selectBuild(current);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  devops.disconnect();
});
</script>

<template>
  <div class="h-full min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-0">
    <section
      class="lg:col-span-5 min-h-0 flex flex-col border-r border-line overflow-hidden"
    >
      <div class="shrink-0 max-h-[58%] overflow-y-auto p-4 pb-3 border-b border-line">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div>
            <h1 class="text-base font-semibold text-ink">Build scripts</h1>
            <p class="text-xs text-ink-muted mt-0.5">
              Devops tự thêm lệnh tại đây — không cần sửa .env.
            </p>
          </div>
          <span class="faw-idle text-xs">
            <span class="faw-idle__dot" :class="idleDot" />
            {{ queueHint }}
          </span>
        </div>

        <div v-if="devops.loading" class="text-sm text-ink-muted">
          Loading scripts…
        </div>
        <div
          v-else-if="!devops.scripts.length && !formOpen"
          class="rounded-lg border border-dashed border-line p-4 text-sm text-ink-muted mb-3"
        >
          Chưa có lệnh nào. Bấm
          <strong class="text-ink">Thêm lệnh</strong>
          để cấu hình (ví dụ
          <code class="text-ink">bash /opt/build/YKKUAT.sh</code>).
        </div>
        <div v-else class="flex flex-col gap-2 mb-3">
          <div
            v-for="s in devops.scripts"
            :key="s.id"
            class="rounded-lg border border-line bg-surface-raised p-3 flex items-start justify-between gap-3"
          >
            <div class="min-w-0">
              <div class="text-sm font-semibold text-ink">{{ s.label }}</div>
              <div class="text-[11px] font-mono text-ink-faint truncate">
                {{ s.command }}
              </div>
              <div class="text-[11px] text-ink-muted truncate mt-0.5">
                cwd {{ s.workingDir }}
                <span v-if="s.timeoutSec"> · timeout {{ s.timeoutSec }}s</span>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                class="text-xs text-ink-muted hover:text-ink hover:underline"
                @click="openEdit(s)"
              >
                Sửa
              </button>
              <a-popconfirm
                title="Xóa lệnh này?"
                ok-text="Xóa"
                cancel-text="Giữ"
                ok-type="danger"
                @confirm="onDeleteScript(s.id)"
              >
                <button
                  type="button"
                  class="text-xs text-red-400 hover:underline"
                  :disabled="devops.deletingScriptId === s.id"
                >
                  Xóa
                </button>
              </a-popconfirm>
              <button
                type="button"
                class="faw-btn faw-btn--run"
                :disabled="devops.triggeringId === s.id || devops.queue.shuttingDown"
                :title="
                  devops.queue.running
                    ? 'Queued — runs when the current job finishes'
                    : 'Enqueue this script'
                "
                @click="onTrigger(s.id)"
              >
                {{ devops.triggeringId === s.id ? "Queuing…" : "Trigger" }}
              </button>
            </div>
          </div>
        </div>

        <button
          v-if="!formOpen"
          type="button"
          class="faw-btn w-full"
          @click="openCreate"
        >
          + Thêm lệnh
        </button>

        <form
          v-else
          class="rounded-lg border border-line bg-surface-raised p-3 flex flex-col gap-2"
          @submit.prevent="onSaveScript"
        >
          <div class="text-sm font-semibold text-ink">{{ formTitle }}</div>
          <label class="text-xs text-ink-muted">
            Tên
            <a-input
              v-model:value="form.label"
              class="mt-1"
              placeholder="YKK UAT"
              required
            />
          </label>
          <label v-if="!editingId" class="text-xs text-ink-muted">
            Id (optional — để trống sẽ slug từ tên)
            <a-input
              v-model:value="form.id"
              class="mt-1 font-mono"
              placeholder="ykkuat"
            />
          </label>
          <label class="text-xs text-ink-muted">
            Lệnh
            <a-input
              v-model:value="form.command"
              class="mt-1 font-mono"
              placeholder="bash /opt/build/YKKUAT.sh"
              required
            />
          </label>
          <label class="text-xs text-ink-muted">
            Working dir
            <a-input
              v-model:value="form.workingDir"
              class="mt-1 font-mono"
              placeholder="/opt/build hoặc ~/projects/ykk"
              required
            />
          </label>
          <label class="text-xs text-ink-muted">
            Timeout (giây, optional)
            <a-input-number
              v-model:value="form.timeoutSec"
              class="mt-1 w-full"
              :min="1"
              :max="86400"
              placeholder="1800"
            />
          </label>
          <div class="flex gap-2 justify-end pt-1">
            <button type="button" class="faw-btn" @click="closeForm">
              Hủy
            </button>
            <button
              type="submit"
              class="faw-btn faw-btn--run"
              :disabled="devops.savingScript || !form.label.trim() || !form.command.trim() || !form.workingDir.trim()"
            >
              {{ devops.savingScript ? "Đang lưu…" : "Lưu" }}
            </button>
          </div>
        </form>
      </div>

      <div class="flex-1 min-h-0 flex flex-col">
        <div
          class="shrink-0 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          History
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          <p
            v-if="!devops.builds.length && !devops.loading"
            class="text-sm text-ink-faint py-8 text-center"
          >
            No builds yet. Trigger a script to enqueue the first job.
          </p>
          <div
            v-for="job in devops.builds"
            :key="job.id"
            class="w-full text-left rounded-lg border border-line px-3 py-2.5 mb-2 hover:bg-surface transition cursor-pointer"
            :class="
              job.id === devops.selectedId
                ? 'border-accent bg-accent-soft'
                : 'bg-surface-raised'
            "
            @click="onSelect(job.id)"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium text-ink truncate">{{
                job.scriptLabel
              }}</span>
              <span
                class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-semibold"
                :class="statusClass(job.status)"
              >
                {{ job.status }}
              </span>
            </div>
            <div class="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-muted">
              <span class="truncate">{{ job.triggeredBy }} · {{ formatDuration(job) }}</span>
              <a-popconfirm
                v-if="canCancel(job)"
                title="Cancel this build?"
                ok-text="Cancel build"
                cancel-text="Keep"
                ok-type="danger"
                @confirm.stop="onCancel(job.id)"
              >
                <span
                  class="text-red-400 hover:underline"
                  :class="{ 'opacity-50': devops.cancellingId === job.id }"
                  @click.stop
                >
                  {{
                    devops.cancellingId === job.id
                      ? "Stopping…"
                      : job.status === "running"
                        ? "Stop"
                        : "Remove"
                  }}
                </span>
              </a-popconfirm>
            </div>
            <p
              v-if="job.errorMessage"
              class="mt-1 text-[11px] text-red-400 truncate"
            >
              {{ job.errorMessage }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <section class="lg:col-span-7 min-h-0 flex flex-col overflow-hidden">
      <div
        class="shrink-0 px-4 py-3 border-b border-line flex items-center justify-between gap-3"
      >
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-ink truncate">
            {{ devops.selected?.scriptLabel || "Live log" }}
          </h2>
          <p class="text-[11px] font-mono text-ink-faint truncate">
            {{
              devops.selected
                ? devops.selected.command
                : "Select a build to stream stdout / stderr"
            }}
          </p>
        </div>
        <span
          v-if="devops.selected"
          class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-semibold shrink-0"
          :class="statusClass(devops.selected.status)"
        >
          {{ devops.selected.status }}
        </span>
      </div>
      <pre
        ref="logBox"
        class="flex-1 min-h-0 overflow-y-auto m-0 p-4 text-[12px] leading-5 font-mono bg-zinc-950 text-zinc-200"
        @scroll="scroll.onScroll"
        @wheel="scroll.onWheel"
        @touchmove="scroll.onTouchMove"
      ><template v-if="devops.logLines.length"><div
          v-for="(line, i) in devops.logLines"
          :key="i"
          :class="logColor(line.stream)"
        ><span class="text-zinc-500 select-none">{{ line.at.slice(11, 19) }} </span><span class="opacity-60">{{ line.stream.padEnd(6) }} </span>{{ line.text }}</div></template><div
          v-else
          class="text-zinc-500"
        >{{
          devops.selected?.status === "queued"
            ? "Waiting in FIFO queue…"
            : "No log yet."
        }}</div></pre>
    </section>
  </div>
</template>
