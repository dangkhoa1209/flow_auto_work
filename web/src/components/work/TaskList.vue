<script setup lang="ts">
import { TransitionGroup, ref, watch } from "vue";
import {
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons-vue";
import {
  statusLabel,
  statusColor,
  MANUAL_JOB_STATUSES,
  contextQualityColor,
} from "@/utils/status";
import type { Job, Task } from "@/stores/work";

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

/** Flash job cards when status changes via SSE */
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
    class="flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel h-full"
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
        <div v-for="n in 5" :key="n" class="rounded-xl border border-line/60 p-2.5 space-y-2">
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
              <div class="text-xs font-semibold text-accent">
                #{{ t.issueIid }}
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
      class="shrink-0 border-t border-line flex flex-col h-[34%] min-h-[132px] max-h-[42%] bg-surface-soft/80 overflow-hidden"
    >
      <div
        class="shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-faint px-3 py-1.5 border-b border-line/60 bg-surface-soft"
      >
        Jobs
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2">
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
              <span class="text-accent text-xs font-semibold shrink-0">{{
                jobDisplayIid(j)
              }}</span>
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
