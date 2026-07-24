<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, TransitionGroup } from "vue";
import {
  PlusOutlined,
  ReloadOutlined,
  DownOutlined,
} from "@ant-design/icons-vue";
import IssueIidLink from "@/components/IssueIidLink.vue";
import {
  statusLabel,
  statusColor,
  MANUAL_JOB_STATUSES,
  contextQualityColor,
} from "@/utils/status";
import type { Job, Task } from "@/stores/work";

const JOBS_OPEN_KEY = "flow.tasklist.jobsOpen";
const JOBS_H_KEY = "flow.tasklist.jobsHeight";
const JOBS_H_MIN = 120;
const JOBS_H_DEFAULT = 220;

const props = defineProps<{
  filteredTasks: Task[];
  sortedJobs: Job[];
  selectedTaskIid: number | null;
  selectedJobId: string | null;
  selectedIids: number[];
  milestones: string[];
  milestoneFilter: string;
  openIidDraft: string;
  loading: boolean;
  busy: boolean;
  jobLoading: boolean;
  jobStatusBusy: string | null;
  runBlockedReason: string | null;
  contextIsBad: boolean;
}>();

const emit = defineEmits<{
  "update:milestoneFilter": [string];
  "update:openIidDraft": [string];
  "update:selectedIids": [number[]];
  refresh: [];
  openAdhoc: [];
  runSelected: [];
  runAll: [];
  openByIid: [];
  selectTask: [number];
  selectJob: [string];
  toggleIid: [iid: number, checked: boolean];
  statusChange: [jobId: string, status: string];
  deleteJob: [jobId: string];
}>();

const rootEl = ref<HTMLElement | null>(null);
const jobsOpen = ref(true);
const jobsHeight = ref(JOBS_H_DEFAULT);
const jobsDragging = ref(false);

let dragStartY = 0;
let dragStartH = 0;
let dragMoved = false;
let dragPointerId: number | null = null;

onMounted(() => {
  try {
    const open = localStorage.getItem(JOBS_OPEN_KEY);
    if (open === "0" || open === "false") jobsOpen.value = false;
    else if (open === "1" || open === "true") jobsOpen.value = true;
    const h = Number(localStorage.getItem(JOBS_H_KEY));
    if (Number.isFinite(h) && h >= JOBS_H_MIN) jobsHeight.value = Math.round(h);
  } catch {
    /* ignore */
  }
});

watch(jobsOpen, (open) => {
  try {
    localStorage.setItem(JOBS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
});

function persistJobsHeight() {
  try {
    localStorage.setItem(JOBS_H_KEY, String(jobsHeight.value));
  } catch {
    /* ignore */
  }
}

function maxJobsHeight() {
  const rootH = rootEl.value?.clientHeight ?? 640;
  return Math.max(JOBS_H_MIN, Math.floor(rootH * 0.72));
}

function clampJobsHeight(h: number) {
  return Math.min(maxJobsHeight(), Math.max(JOBS_H_MIN, Math.round(h)));
}

function toggleJobs() {
  jobsOpen.value = !jobsOpen.value;
}

function onJobsRailPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  if (!jobsOpen.value) {
    jobsOpen.value = true;
    return;
  }
  dragStartY = e.clientY;
  dragStartH = jobsHeight.value;
  dragMoved = false;
  dragPointerId = e.pointerId;
  jobsDragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", onJobsRailPointerMove);
  window.addEventListener("pointerup", onJobsRailPointerUp);
  window.addEventListener("pointercancel", onJobsRailPointerUp);
}

function onJobsRailPointerMove(e: PointerEvent) {
  if (!jobsDragging.value) return;
  const dy = dragStartY - e.clientY;
  if (Math.abs(dy) > 4) dragMoved = true;
  jobsHeight.value = clampJobsHeight(dragStartH + dy);
}

function onJobsRailPointerUp(e: PointerEvent) {
  if (dragPointerId != null && e.pointerId !== dragPointerId) return;
  window.removeEventListener("pointermove", onJobsRailPointerMove);
  window.removeEventListener("pointerup", onJobsRailPointerUp);
  window.removeEventListener("pointercancel", onJobsRailPointerUp);
  jobsDragging.value = false;
  dragPointerId = null;
  if (!dragMoved) {
    toggleJobs();
  } else {
    persistJobsHeight();
  }
}

onUnmounted(() => {
  window.removeEventListener("pointermove", onJobsRailPointerMove);
  window.removeEventListener("pointerup", onJobsRailPointerUp);
  window.removeEventListener("pointercancel", onJobsRailPointerUp);
});

function jobDisplayIid(j: Job) {
  const iid = j.issue?.issueIid;
  if (!iid || iid <= 0 || j.kind === "adhoc") return "Hotfix";
  return `#${iid}`;
}

function jobMilestone(j: Job) {
  const fromIssue = (j.issue?.milestone?.title || "").trim();
  if (fromIssue) return fromIssue;
  const iid = j.issue?.issueIid;
  if (!iid || iid <= 0) return "";
  return (
    props.filteredTasks.find((t) => t.issueIid === iid)?.milestone?.title || ""
  ).trim();
}

function jobLabels(j: Job) {
  const fromIssue = (j.issue?.labels || []).filter(Boolean);
  if (fromIssue.length) return fromIssue;
  const iid = j.issue?.issueIid;
  if (!iid || iid <= 0) return [];
  return (props.filteredTasks.find((t) => t.issueIid === iid)?.labels || []).filter(
    Boolean,
  );
}

const flashIds = ref<Set<string>>(new Set());
const prevStatus = ref<Map<string, string>>(new Map());

watch(
  () => props.sortedJobs.map((j) => `${j.id}:${j.status}`).join("|"),
  () => {
    const next = new Map<string, string>();
    for (const j of props.sortedJobs) {
      next.set(j.id, j.status);
      const prev = prevStatus.value.get(j.id);
      if (prev && prev !== j.status) {
        flashIds.value = new Set(flashIds.value).add(j.id);
        window.setTimeout(() => {
          const s = new Set(flashIds.value);
          s.delete(j.id);
          flashIds.value = s;
        }, 1000);
      }
    }
    prevStatus.value = next;
  },
);
</script>

<template>
  <aside
    ref="rootEl"
    class="flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel h-full"
    :class="{ 'select-none': jobsDragging }"
  >
    <div class="shrink-0 p-3 border-b border-line space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1 min-w-0">
          <span class="text-sm font-semibold text-ink">Tasks</span>
          <a-button
            type="text"
            size="small"
            :loading="busy || loading"
            title="Refresh tasks"
            @click="emit('refresh')"
          >
            <template #icon><ReloadOutlined /></template>
          </a-button>
        </div>
        <div class="flex gap-1 flex-wrap justify-end">
          <a-button size="small" @click="emit('openAdhoc')">
            <template #icon><PlusOutlined /></template>
            <span class="hidden sm:inline">Hotfix</span>
          </a-button>
          <a-tooltip v-if="runBlockedReason" :title="runBlockedReason">
            <a-button
              size="small"
              type="primary"
              :loading="busy"
              disabled
              >Run</a-button
            >
          </a-tooltip>
          <a-button
            v-else
            size="small"
            type="primary"
            :loading="busy"
            title="⌘/Ctrl+Enter"
            @click="emit('runSelected')"
            >Run</a-button
          >
          <a-button size="small" :loading="busy" @click="emit('runAll')"
            >All</a-button
          >
        </div>
      </div>
      <a-select
        :value="milestoneFilter"
        size="small"
        class="w-full"
        :options="
          milestones.map((m) => ({
            value: m,
            label:
              m === 'all'
                ? 'All milestones'
                : m === '__none__'
                  ? 'No milestone'
                  : m,
          }))
        "
        @update:value="(v: string) => emit('update:milestoneFilter', v)"
      />
      <label class="flex items-center gap-1.5 text-[11px] text-ink-faint">
        <span class="shrink-0">#iid</span>
        <a-input
          :value="openIidDraft"
          size="small"
          class="flex-1 !text-xs"
          placeholder="Enter…"
          allow-clear
          @update:value="(v: string) => emit('update:openIidDraft', v)"
          @pressEnter="emit('openByIid')"
        />
      </label>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto p-2 relative">
      <div v-if="loading" class="space-y-2 p-1" aria-hidden="true">
        <div
          v-for="n in 5"
          :key="n"
          class="rounded-xl border border-line/60 p-2.5 space-y-2"
        >
          <div class="skel h-3 w-12" />
          <div class="skel h-3.5 w-[88%]" />
          <div class="skel h-2.5 w-2/3" />
        </div>
      </div>
      <TransitionGroup
        v-else
        name="list-slide"
        tag="div"
        class="space-y-1 relative"
      >
        <div
          v-for="t in filteredTasks"
          :key="t.issueIid"
          class="rounded-xl px-2.5 py-2 cursor-pointer hover:bg-surface-muted border border-transparent fx-colors active:bg-surface-muted"
          :class="
            selectedTaskIid === t.issueIid
              ? '!border-accent/40 !bg-accent-soft'
              : ''
          "
          @click="emit('selectTask', t.issueIid)"
        >
          <div class="flex items-start gap-2">
            <a-checkbox
              :checked="selectedIids.includes(t.issueIid)"
              @click.stop
              @change="
                (e: { target: { checked: boolean } }) =>
                  emit('toggleIid', t.issueIid, e.target.checked)
              "
            />
            <div class="min-w-0">
              <div class="text-xs">
                <IssueIidLink :iid="t.issueIid" :url="t.url" link-class="!text-xs" />
              </div>
              <div class="text-sm text-ink-soft line-clamp-2">{{ t.title }}</div>
              <div
                v-if="t.milestone?.title || (t.labels && t.labels.length)"
                class="flex flex-wrap items-center gap-1 mt-1 min-w-0"
              >
                <span
                  v-if="t.milestone?.title"
                  class="text-[10px] text-ink-faint truncate max-w-full"
                  :title="t.milestone.title"
                  >{{ t.milestone.title }}</span
                >
                <a-tag
                  v-for="l in t.labels || []"
                  :key="l"
                  class="m-0 !text-[10px] !leading-4 !px-1 !py-0 max-w-[7rem] truncate"
                  :title="l"
                  >{{ l }}</a-tag
                >
              </div>
            </div>
          </div>
        </div>
      </TransitionGroup>
      <a-empty
        v-if="!loading && !filteredTasks.length"
        class="py-6"
        description="Không có task"
      >
        <a-button size="small" type="primary" @click="emit('refresh')"
          >Refresh</a-button
        >
      </a-empty>
    </div>

    <div
      class="jobs-panel shrink-0 flex flex-col overflow-hidden border-t border-line bg-surface-soft/80"
      :class="{ 'is-dragging': jobsDragging, 'is-collapsed': !jobsOpen }"
      :style="jobsOpen ? { height: `${jobsHeight}px` } : undefined"
    >
      <button
        type="button"
        class="jobs-panel__rail"
        :title="
          jobsOpen
            ? 'Kéo để đổi chiều cao · click để thu gọn'
            : 'Mở Jobs'
        "
        :aria-expanded="jobsOpen"
        @pointerdown="onJobsRailPointerDown"
      >
        <span class="jobs-panel__grip" aria-hidden="true">
          <i /><i /><i />
        </span>
        <span class="jobs-panel__label">Jobs</span>
        <span v-if="sortedJobs.length" class="jobs-panel__count">{{
          sortedJobs.length
        }}</span>
        <span class="flex-1" />
        <DownOutlined
          class="jobs-panel__chevron"
          :class="{ 'is-open': jobsOpen }"
        />
      </button>

      <div
        v-show="jobsOpen"
        class="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2"
      >
        <TransitionGroup
          name="list-slide"
          tag="div"
          class="space-y-1 relative"
        >
          <div
            v-for="j in sortedJobs"
            :key="j.id"
            class="rounded-lg px-2 py-1.5 cursor-pointer hover:bg-surface-raised text-sm border border-transparent relative group/job active:bg-surface-raised fx-colors"
            :class="[
              selectedJobId === j.id
                ? '!bg-surface-raised !border-line shadow-sm'
                : '',
              flashIds.has(j.id) ? 'ring-2 ring-blue-400/70 shadow-sm' : '',
            ]"
            @click="emit('selectJob', j.id)"
          >
            <div class="flex items-center gap-1.5 min-w-0">
              <div @click.stop>
                <a-dropdown
                  :trigger="['click']"
                  :disabled="jobStatusBusy === j.id"
                >
                  <a-tag
                    :color="statusColor(j.status)"
                    class="m-0 !text-[10px] !leading-4 !px-1.5 !py-0 cursor-pointer max-w-[7.5rem] truncate fx-colors"
                  >
                    {{ statusLabel(j.status) }}
                    <span class="opacity-60 ml-0.5">▾</span>
                  </a-tag>
                  <template #overlay>
                    <a-menu
                      :selected-keys="[j.status]"
                      @click="
                        ({ key }: { key: string }) =>
                          emit('statusChange', j.id, key)
                      "
                    >
                      <a-menu-item
                        v-if="
                          !(MANUAL_JOB_STATUSES as readonly string[]).includes(
                            j.status,
                          )
                        "
                        :key="j.status"
                        disabled
                      >
                        {{ statusLabel(j.status) }}
                      </a-menu-item>
                      <a-menu-item v-for="s in MANUAL_JOB_STATUSES" :key="s">
                        {{ statusLabel(s) }}
                      </a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown>
              </div>
              <a-tag
                v-if="j.contextQuality?.level"
                :color="contextQualityColor(j.contextQuality.level)"
                class="m-0 !text-[10px] !leading-4 !px-1 !py-0 shrink-0 fx-colors"
                :title="j.contextQuality.reason || ''"
              >
                {{
                  j.contextQuality.level === "good"
                    ? "Good"
                    : j.contextQuality.level === "searchable"
                      ? "Search"
                      : "Bad"
                }}
              </a-tag>
              <span
                v-if="jobDisplayIid(j) === 'Hotfix'"
                class="text-accent text-xs font-semibold shrink-0"
                >Hotfix</span
              >
              <IssueIidLink
                v-else
                :iid="j.issue?.issueIid"
                :url="j.issue?.url"
                link-class="!text-xs shrink-0"
              />
              <a-spin
                v-if="jobLoading && selectedJobId === j.id"
                size="small"
                class="ml-auto"
              />
              <a-popconfirm
                v-else
                title="Xóa job này?"
                ok-text="Xóa"
                cancel-text="Huỷ"
                ok-type="danger"
                @confirm="emit('deleteJob', j.id)"
              >
                <button
                  type="button"
                  class="ml-auto shrink-0 text-[11px] leading-none text-ink-faint hover:text-red-500 opacity-100 sm:opacity-0 sm:group-hover/job:opacity-100 fx-colors px-0.5"
                  :disabled="jobStatusBusy === j.id"
                  @click.stop
                  title="Xóa job"
                >
                  ×
                </button>
              </a-popconfirm>
            </div>
            <div class="truncate text-ink-muted text-xs mt-0.5">
              {{ j.issue?.title }}
            </div>
            <div
              v-if="jobMilestone(j) || jobLabels(j).length"
              class="flex flex-wrap items-center gap-1 mt-1 min-w-0"
            >
              <span
                v-if="jobMilestone(j)"
                class="text-[10px] text-ink-faint truncate max-w-full"
                :title="jobMilestone(j)"
                >{{ jobMilestone(j) }}</span
              >
              <a-tag
                v-for="l in jobLabels(j)"
                :key="l"
                class="m-0 !text-[10px] !leading-4 !px-1 !py-0 max-w-[7rem] truncate"
                :title="l"
                >{{ l }}</a-tag
              >
            </div>
          </div>
        </TransitionGroup>
        <a-empty
          v-if="!sortedJobs.length"
          class="py-4"
          description="Chưa có job"
        >
          <span class="text-xs text-ink-faint">Chọn task rồi bấm Run</span>
        </a-empty>
      </div>
    </div>
  </aside>
</template>
