<script setup lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  watch,
  TransitionGroup,
} from "vue";
import {
  PlusOutlined,
  ReloadOutlined,
  DownOutlined,
} from "@ant-design/icons-vue";
import IssueIidLink from "@/components/IssueIidLink.vue";
import GitlabLabelChip from "@/components/GitlabLabelChip.vue";
import { statusLabel, MANUAL_JOB_STATUSES, manualStatusMenuLabel } from "@/utils/status";
import type { Job, Task } from "@/stores/work";
import { useWorkStore } from "@/stores/work";
import { gitlabLabelChipStyle } from "@/utils/gitlabLabel";

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
  taskLabels: string[];
  labelFilter: string;
  openIidDraft: string;
  loading: boolean;
  busy: boolean;
  jobLoading: boolean;
  jobStatusBusy: string | null;
  runBlockedReason: string | null;
  contextIsBad: boolean;
  canKillAll?: boolean;
  killAllBusy?: boolean;
}>();

const emit = defineEmits<{
  "update:milestoneFilter": [string];
  "update:labelFilter": [string];
  "update:openIidDraft": [string];
  "update:selectedIids": [number[]];
  refresh: [];
  startChat: [];
  runSelected: [];
  openByIid: [];
  selectTask: [number];
  selectJob: [string];
  toggleIid: [iid: number, checked: boolean];
  statusChange: [jobId: string, status: string];
  deleteJob: [jobId: string];
  killAll: [];
}>();

const work = useWorkStore();

function filterOptionLabel(kind: "milestone" | "label", v: string) {
  if (v === "all") return kind === "milestone" ? "All milestones" : "All labels";
  if (v === "__none__") return kind === "milestone" ? "No milestone" : "No labels";
  return v;
}

function labelSwatchBg(name: string): string | undefined {
  return gitlabLabelChipStyle(work.labelCatalog[name])?.background;
}

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
  e.preventDefault();
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

const taskSearch = ref("");

const visibleTasks = computed(() => {
  const q = taskSearch.value.trim().toLowerCase();
  if (!q) return props.filteredTasks;
  const qBare = q.startsWith("#") ? q.slice(1) : q;
  return props.filteredTasks.filter((t) => {
    if (t.title.toLowerCase().includes(q)) return true;
    if (String(t.issueIid).includes(qBare)) return true;
    const labels = (t.labels || []).join(" ").toLowerCase();
    if (labels.includes(q)) return true;
    return false;
  });
});

function statusDotClass(status: string) {
  if (status === "succeeded") return "done";
  if (status === "failed") return "bug";
  if (status === "running" || status === "queued") return "wip";
  if (status.startsWith("awaiting_")) return "wip";
  return "idle";
}

function jobDisplayIid(j: Job) {
  const iid = j.issue?.issueIid;
  if (!iid || iid <= 0 || j.kind === "adhoc") return "Session";
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
  return (
    props.filteredTasks.find((t) => t.issueIid === iid)?.labels || []
  ).filter(Boolean);
}

function contextQualityShort(level?: string) {
  if (level === "good") return "Good";
  if (level === "searchable") return "Search";
  if (level === "bad") return "Bad";
  return "";
}

function jobSecondaryChip(j: Job): { label: string; title?: string } | null {
  const cq = j.contextQuality?.level;
  if (cq) {
    return {
      label: contextQualityShort(cq),
      title: j.contextQuality?.reason || undefined,
    };
  }
  const labels = jobLabels(j);
  if (labels.length) return { label: labels[0], title: labels[0] };
  const ms = jobMilestone(j);
  if (ms) return { label: ms, title: ms };
  return null;
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
    class="faw-col flex flex-col min-h-0 overflow-hidden h-full"
    :class="{ 'select-none': jobsDragging }"
  >
    <div class="faw-col-head">
      <h2>Tasks</h2>
      <span class="faw-count">{{ sortedJobs.length }} jobs</span>
      <button
        type="button"
        class="faw-icon-btn"
        title="Refresh tasks"
        :disabled="busy || loading"
        @click="emit('refresh')"
      >
        <ReloadOutlined />
      </button>
    </div>

    <div class="faw-filters">
      <div class="faw-filters__row">
        <div class="faw-field">
          <a-select
            :value="milestoneFilter"
            size="small"
            class="w-full faw-select-ghost"
            :bordered="false"
            :options="
              milestones.map((m) => ({
                value: m,
                label: filterOptionLabel('milestone', m),
              }))
            "
            @update:value="(v: string) => emit('update:milestoneFilter', v)"
          />
        </div>
        <div class="faw-field">
          <a-select
            :value="labelFilter"
            size="small"
            class="w-full faw-select-ghost"
            :bordered="false"
            :options="
              taskLabels.map((m) => ({
                value: m,
                label: filterOptionLabel('label', m),
              }))
            "
            @update:value="(v: string) => emit('update:labelFilter', v)"
          >
            <template #option="{ value, label }">
              <span class="inline-flex items-center gap-1.5 min-w-0">
                <i
                  v-if="
                    value !== 'all' &&
                    value !== '__none__' &&
                    labelSwatchBg(String(value))
                  "
                  class="faw-label-swatch"
                  :style="{ background: labelSwatchBg(String(value)) }"
                />
                <span class="truncate">{{ label }}</span>
              </span>
            </template>
          </a-select>
        </div>
      </div>
      <div class="faw-filters__row">
        <div class="faw-field faw-field--iid">
          <a-input
            :value="openIidDraft"
            size="small"
            class="faw-input-ghost font-mono"
            placeholder="#iid"
            :bordered="false"
            @update:value="(v: string) => emit('update:openIidDraft', v)"
            @pressEnter="emit('openByIid')"
          />
        </div>
        <div class="faw-field faw-field--grow">
          <a-input
            v-model:value="taskSearch"
            size="small"
            class="faw-input-ghost"
            placeholder="Search title, tag…"
            :bordered="false"
            allow-clear
          />
        </div>
        <button type="button" class="faw-btn" title="New session with a title" @click="emit('openAdhoc')">
          <PlusOutlined /> Session
        </button>
      </div>
      <div class="faw-filters__row">
        <button
          type="button"
          class="faw-btn faw-btn--run"
          title="Type a request — no GitLab issue needed"
          @click="emit('startChat')"
        >
          Chat
        </button>
        <button
          type="button"
          class="faw-btn faw-btn--run"
          style="flex: 1"
          :disabled="busy"
          title="Checked Open tasks · ⌘/Ctrl+Enter"
          @click="emit('runSelected')"
        >
          ▶ Run
        </button>
        <a-popconfirm
          v-if="canKillAll"
          title="Stop all running and queued jobs?"
          ok-text="Kill all"
          cancel-text="Cancel"
          ok-type="danger"
          @confirm="emit('killAll')"
        >
          <button
            type="button"
            class="faw-btn faw-btn--danger"
            :disabled="killAllBusy || busy"
            title="Force stop all active jobs"
          >
            {{ killAllBusy ? "Stopping…" : "Kill all" }}
          </button>
        </a-popconfirm>
      </div>
    </div>

    <!-- Open tasks (flex scroll) -->
    <div class="faw-list-scroll flex-1 min-h-0">
      <div v-if="loading" class="space-y-1.5 p-2" aria-hidden="true">
        <div v-for="n in 5" :key="n" class="skel h-10 w-full" />
      </div>

      <template v-else>
        <div class="faw-group-label">
          Open <span class="n">{{ visibleTasks.length }}</span>
        </div>

        <TransitionGroup name="list-slide" tag="div" class="relative">
          <div
            v-for="t in visibleTasks"
            :key="t.issueIid"
            class="faw-task-row"
            :class="{ active: selectedTaskIid === t.issueIid }"
            @click="emit('selectTask', t.issueIid)"
          >
            <a-checkbox
              :checked="selectedIids.includes(t.issueIid)"
              @click.stop
              @change="
                (e: { target: { checked: boolean } }) =>
                  emit('toggleIid', t.issueIid, e.target.checked)
              "
            />
            <div class="min-w-0">
              <div class="faw-task-row__id">
                <IssueIidLink
                  :iid="t.issueIid"
                  :url="t.url"
                  link-class="!text-[10.5px] !font-mono"
                />
              </div>
              <div class="faw-task-row__title">{{ t.title }}</div>
              <div
                v-if="t.milestone?.title || (t.labels && t.labels.length)"
                class="faw-chips"
              >
                <span v-if="t.milestone?.title" class="faw-chip" :title="t.milestone.title">{{
                  t.milestone.title
                }}</span>
                <GitlabLabelChip
                  v-for="l in t.labels || []"
                  :key="l"
                  :name="l"
                />
              </div>
            </div>
          </div>
        </TransitionGroup>

        <a-empty
          v-if="!visibleTasks.length"
          class="py-6"
          description="No assigned GitLab tasks"
        >
          <div class="flex flex-wrap gap-2 justify-center">
            <a-button size="small" type="primary" @click="emit('startChat')"
              >Start from chat</a-button
            >
            <a-button size="small" @click="emit('refresh')">Refresh</a-button>
          </div>
        </a-empty>
      </template>
    </div>

    <!-- Jobs — resizable / collapsible -->
    <div
      class="jobs-panel shrink-0 flex flex-col overflow-hidden border-t border-line"
      :class="{ 'is-dragging': jobsDragging, 'is-collapsed': !jobsOpen }"
      :style="jobsOpen ? { height: `${jobsHeight}px` } : undefined"
    >
      <button
        type="button"
        class="jobs-panel__rail"
        :title="
          jobsOpen
            ? 'Drag to resize · click to collapse'
            : 'Open Jobs'
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
        class="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      >
        <TransitionGroup
          name="list-slide"
          tag="div"
          class="relative"
        >
          <div
            v-for="j in sortedJobs"
            :key="j.id"
            class="faw-job-row group/job"
            :class="{
              active: selectedJobId === j.id,
              flash: flashIds.has(j.id),
            }"
            @click="emit('selectJob', j.id)"
          >
            <div @click.stop>
              <a-dropdown
                :trigger="['click']"
                :disabled="jobStatusBusy === j.id"
              >
                <button
                  type="button"
                  class="faw-job-status"
                  :title="`Change status · ${statusLabel(j.status)}`"
                >
                  <span
                    class="faw-job-dot"
                    :class="statusDotClass(j.status)"
                  />
                  <span class="faw-job-status__lbl">{{
                    statusLabel(j.status)
                  }}</span>
                </button>
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
                      {{ manualStatusMenuLabel(s) }}
                    </a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </div>

            <span
              v-if="jobDisplayIid(j) === 'Session'"
              class="faw-job-id"
              >Session</span
            >
            <IssueIidLink
              v-else
              :iid="j.issue?.issueIid"
              :url="j.issue?.url"
              link-class="faw-job-id !no-underline"
            />

            <span class="faw-job-t" :title="j.issue?.title">{{
              j.issue?.title
            }}</span>

            <span
              v-if="jobSecondaryChip(j)"
              class="faw-job-tag"
              :title="jobSecondaryChip(j)?.title"
              >{{ jobSecondaryChip(j)?.label }}</span
            >

            <a-spin
              v-if="jobLoading && selectedJobId === j.id"
              size="small"
              class="shrink-0"
            />
            <a-popconfirm
              v-else
              title="Delete this job?"
              ok-text="Delete"
              cancel-text="Cancel"
              ok-type="danger"
              @confirm="emit('deleteJob', j.id)"
            >
              <button
                type="button"
                class="faw-job-del"
                :disabled="jobStatusBusy === j.id"
                title="Delete job"
                @click.stop
              >
                ×
              </button>
            </a-popconfirm>
          </div>
        </TransitionGroup>

        <a-empty
          v-if="!sortedJobs.length"
          class="py-4"
          description="No jobs yet"
        >
          <span class="text-[11px] text-ink-faint"
            >Type in Console to start a session, or Run a GitLab task</span
          >
        </a-empty>
      </div>
    </div>
  </aside>
</template>
