<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { DownloadOutlined, SearchOutlined, BarChartOutlined } from "@ant-design/icons-vue";
import { api } from "@/api/client";
import IssueIidLink from "@/components/IssueIidLink.vue";
import Sparkline from "@/components/stats/Sparkline.vue";
import ContributionHeatmap from "@/components/stats/ContributionHeatmap.vue";
import DevEvaluation from "@/components/stats/DevEvaluation.vue";
import type { DevAnalysis } from "@/components/stats/DevEvaluation.vue";
import { statusLabel, statusColor } from "@/utils/status";
import { useSessionStore } from "@/stores/session";
import { useWorkStore } from "@/stores/work";

type DayItem = {
  jobId: string;
  issueIid?: number;
  title?: string;
  status?: string;
  url?: string;
  error?: string;
  at?: string;
};

type Counts = {
  jobCount?: number;
  succeeded?: number;
  failed?: number;
  awaitingHandoff?: number;
  successRate?: number | null;
  spark?: number[];
};

type DayBucket = Counts & {
  date: string;
  items: DayItem[];
};

type WeekNode = Counts & {
  weekKey: string;
  label: string;
  weekStart: string;
  weekEnd: string;
  days: DayBucket[];
};

type MonthNode = Counts & {
  monthKey: string;
  label: string;
  weeks: WeekNode[];
};

type StatsPayload = {
  from?: string;
  to?: string;
  days?: number;
  truncated?: boolean;
  totalJobsInRange?: number;
  returnedJobs?: number;
  timezone?: string;
  totals?: Counts;
  daily?: DayBucket[];
  months?: MonthNode[];
  compare?: {
    jobsPct: number | null;
    successRateDelta: number | null;
    previousJobs: number;
  };
  failReasons?: { reason: string; count: number }[];
  heatmap?: { date: string; jobs: number; tokens: number }[];
  filters?: {
    projects: string[];
  };
  pendingHandoffCount?: number;
};

const work = useWorkStore();
const session = useSessionStore();
const loading = ref(false);
const payload = ref<StatsPayload | null>(null);
const daysPreset = ref<number>(90);
const customFrom = ref<string | undefined>();
const customTo = ref<string | undefined>();
const statusFilter = ref<string[]>([]);
const projectFilter = ref<string>("current");
const search = ref("");
const searchDebounced = ref("");
const drillMonth = ref<string | null>(null);
const drillWeek = ref<string | null>(null);
const refreshing = ref(false);
const analyzing = ref(false);
const analysis = ref<DevAnalysis | null>(null);
const highlightJobIds = ref<Set<string>>(new Set());
const LIST_PAGE = 100;
const listLimit = ref(LIST_PAGE);

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

watch(search, (v) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    searchDebounced.value = v.trim();
  }, 400);
});

watch(searchDebounced, () => {
  listLimit.value = LIST_PAGE;
  load();
});

function resetListPage() {
  listLimit.value = LIST_PAGE;
}

const liveBusy = computed(() =>
  work.jobs.some((j) =>
    ["running", "queued", "awaiting_handoff"].includes(j.status),
  ),
);

function fmtPct(n?: number | null): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}%`;
}

function pctClass(n?: number | null): string {
  if (n == null || n === 0) return "text-ink-muted";
  return n > 0 ? "text-status-done" : "text-red-500";
}

function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function monthCrumb(key: string): string {
  const [y, m] = key.split("-");
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
  }).format(new Date(Number(y), Number(m) - 1, 1));
}

function ymdShort(ymd?: string): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-");
  if (!y || !m || !d) return ymd;
  return `${m}/${d}`;
}

async function load(silent = false) {
  if (!silent) loading.value = true;
  else refreshing.value = true;
  try {
    const data = await api<StatsPayload>(
      `/api/stats/daily?${buildStatsParams()}`,
    );
    payload.value = data;
  } catch (e) {
    if (!silent) message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

function buildStatsParams(extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (customFrom.value && customTo.value) {
    params.set("from", customFrom.value);
    params.set("to", customTo.value);
  } else {
    params.set("days", String(daysPreset.value));
  }
  if (statusFilter.value.length) {
    params.set("status", statusFilter.value.join(","));
  }
  if (projectFilter.value === "all") params.set("allProjects", "1");
  else if (projectFilter.value && projectFilter.value !== "current") {
    params.set("workspaceProjectId", projectFilter.value);
  }
  if (searchDebounced.value) params.set("q", searchDebounced.value);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
  }
  return params.toString();
}

async function runAnalyze(force = false) {
  analyzing.value = true;
  try {
    const qs = buildStatsParams(force ? { force: "1" } : undefined);
    analysis.value = await api<DevAnalysis>(`/api/stats/analyze?${qs}`, {
      method: "POST",
    });
    if (analysis.value.cached && !force) {
      message.info("Using cached analysis (no new jobs).");
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    analyzing.value = false;
  }
}

function onHighlightJobs(ids: string[]) {
  highlightJobIds.value = new Set(ids);
  listLimit.value = Math.max(listLimit.value, ids.length + 20);
}

const months = computed(() => payload.value?.months || []);

const currentMonth = computed(
  () => months.value.find((m) => m.monthKey === drillMonth.value) || null,
);

const currentWeek = computed(
  () =>
    currentMonth.value?.weeks.find((w) => w.weekKey === drillWeek.value) ||
    null,
);

const levelCounts = computed<Counts>(() => {
  if (currentWeek.value) return currentWeek.value;
  if (currentMonth.value) return currentMonth.value;
  return payload.value?.totals || {};
});

const scopedItems = computed<DayItem[]>(() => {
  if (currentWeek.value) return currentWeek.value.days.flatMap((d) => d.items);
  if (currentMonth.value) {
    return currentMonth.value.weeks.flatMap((w) =>
      w.days.flatMap((d) => d.items),
    );
  }
  return (payload.value?.daily || []).flatMap((d) => d.items);
});

const activeDayCount = computed(() => {
  if (currentWeek.value) return currentWeek.value.days.length;
  if (currentMonth.value) {
    return currentMonth.value.weeks.reduce((s, w) => s + w.days.length, 0);
  }
  return payload.value?.daily?.length || 0;
});

const avgTasksPerDay = computed(() => {
  const tasks = levelCounts.value.jobCount || 0;
  const days = activeDayCount.value || payload.value?.days || 1;
  if (!tasks) return "0";
  return (tasks / days).toFixed(1);
});

const periodCompareLabel = computed(() =>
  currentWeek.value ? "vs last week" : "vs prior period",
);

const periodComparePct = computed(() => {
  if (currentWeek.value && currentMonth.value) {
    const weeks = currentMonth.value.weeks;
    const i = weeks.findIndex((w) => w.weekKey === currentWeek.value!.weekKey);
    const prev = i >= 0 ? weeks[i + 1] : undefined;
    if (prev) {
      return pctDelta(
        currentWeek.value.jobCount || 0,
        prev.jobCount || 0,
      );
    }
  }
  return payload.value?.compare?.jobsPct ?? null;
});

const filteredTasks = computed(() => {
  const q = search.value.trim().toLowerCase();
  let items = scopedItems.value;
  if (q) {
    items = items.filter((it) => {
      const iid = String(it.issueIid || "");
      const title = (it.title || "").toLowerCase();
      return iid.includes(q.replace(/^#/, "")) || title.includes(q);
    });
  }
  return [...items].sort((a, b) => (b.at || "").localeCompare(a.at || ""));
});

const displayTasks = computed(() =>
  filteredTasks.value.slice(0, listLimit.value),
);

const hasMoreTasks = computed(
  () => displayTasks.value.length < filteredTasks.value.length,
);

function loadMoreTasks() {
  listLimit.value += LIST_PAGE;
}

const visibleDays = computed(() => currentWeek.value?.days || []);

function openMonth(m: MonthNode) {
  drillMonth.value = m.monthKey;
  drillWeek.value = null;
  resetListPage();
}

function openWeek(w: WeekNode) {
  drillWeek.value = w.weekKey;
  resetListPage();
}

function crumbRoot() {
  drillMonth.value = null;
  drillWeek.value = null;
  resetListPage();
}

function crumbMonth() {
  drillWeek.value = null;
  resetListPage();
}

function applyPreset(n: number) {
  daysPreset.value = n;
  customFrom.value = undefined;
  customTo.value = undefined;
  resetListPage();
  load();
}

function toYmd(v: unknown): string | undefined {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (v && typeof v === "object" && "format" in v) {
    return (v as { format: (s: string) => string }).format("YYYY-MM-DD");
  }
  return undefined;
}

function applyCustomRange(range: unknown) {
  if (!Array.isArray(range) || !range[0] || !range[1]) {
    customFrom.value = undefined;
    customTo.value = undefined;
    resetListPage();
    load();
    return;
  }
  customFrom.value = toYmd(range[0]);
  customTo.value = toYmd(range[1]);
  resetListPage();
  load();
}

const rangeValue = computed<[string, string] | undefined>(() => {
  if (customFrom.value && customTo.value) {
    return [customFrom.value, customTo.value];
  }
  return undefined;
});

function exportCsv() {
  const items = filteredTasks.value;
  if (!items.length) {
    message.warning("Nothing to export");
    return;
  }
  const header = ["date", "issueIid", "title", "status", "url"];
  const lines = [
    header.join(","),
    ...items.map((it) =>
      [
        (it.at || "").slice(0, 10),
        it.issueIid ?? "",
        csvEscape(it.title || ""),
        it.status || "",
        it.url || "",
      ].join(","),
    ),
  ];
  const blob = new Blob(["\uFEFF" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `flow-stats-${payload.value?.from || "range"}-${payload.value?.to || ""}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

onMounted(async () => {
  await load();
  pollTimer = setInterval(() => {
    if (liveBusy.value || (payload.value?.pendingHandoffCount || 0) > 0) {
      load(true);
    }
  }, 25_000);
});

onUnmounted(() => {
  clearTimeout(debounceTimer);
  if (pollTimer) clearInterval(pollTimer);
});

watch(
  [statusFilter, projectFilter],
  () => {
    resetListPage();
    analysis.value = null;
    load();
  },
  { deep: true },
);

watch(
  () => session.projectId,
  () => {
    drillMonth.value = null;
    drillWeek.value = null;
    resetListPage();
    analysis.value = null;
    load();
  },
);
</script>

<template>
  <div class="h-full max-h-full min-h-0 overflow-y-auto">
    <div class="mx-auto w-full max-w-6xl px-4 py-5 md:px-8 md:py-6 pb-10">
      <div class="rounded-2xl panel-glass shadow-panel p-5 md:p-6">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 class="text-lg font-semibold text-ink mt-0 mb-1">Task stats</h2>
            <p class="text-xs text-ink-muted m-0">
              {{ payload?.from }} → {{ payload?.to }}
              · {{ payload?.timezone }}
              <span v-if="session.me?.gitlabUsername || session.session.username">
                · @{{ session.me?.gitlabUsername || session.session.username }}
              </span>
              <span v-if="refreshing" class="ml-2">refreshing…</span>
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <a-button
              type="primary"
              size="small"
              :loading="analyzing"
              :disabled="analyzing"
              @click="runAnalyze(!!analysis)"
            >
              <template #icon><BarChartOutlined /></template>
              {{
                analyzing
                  ? "Agent is analyzing…"
                  : analysis
                    ? "Analyze again"
                    : "Analyze performance"
              }}
            </a-button>
            <a-button size="small" @click="exportCsv">
              <template #icon><DownloadOutlined /></template>
              Export CSV
            </a-button>
          </div>
        </div>

        <DevEvaluation
          v-if="analysis"
          :analysis="analysis"
          class="mb-4"
          @highlight-jobs="onHighlightJobs"
        />

        <a-alert
          v-if="payload?.truncated"
          type="warning"
          show-icon
          class="mb-3"
          :message="`Incomplete data: showing ${payload.returnedJobs} / ${payload.totalJobsInRange} tasks in this range.`"
        />

        <div class="flex flex-wrap gap-2 mb-4">
          <a-radio-group
            :value="customFrom ? 0 : daysPreset"
            size="small"
            @change="(e: { target?: { value?: number } } | number) => applyPreset(typeof e === 'number' ? e : Number(e.target?.value))"
          >
            <a-radio-button :value="7">7 days</a-radio-button>
            <a-radio-button :value="30">30 days</a-radio-button>
            <a-radio-button :value="90">90 days</a-radio-button>
          </a-radio-group>
          <a-range-picker
            size="small"
            value-format="YYYY-MM-DD"
            :value="rangeValue"
            @change="(_d: unknown, strings: string[] | string) => applyCustomRange(strings)"
          />
          <a-select
            v-model:value="statusFilter"
            mode="multiple"
            allow-clear
            placeholder="Status"
            size="small"
            class="min-w-[140px]"
            :max-tag-count="1"
          >
            <a-select-option value="succeeded">Done</a-select-option>
            <a-select-option value="failed">Failed</a-select-option>
            <a-select-option value="awaiting_handoff">Handoff</a-select-option>
            <a-select-option value="running">Running</a-select-option>
          </a-select>
          <a-select
            v-model:value="projectFilter"
            size="small"
            class="min-w-[130px]"
          >
            <a-select-option value="current">Current project</a-select-option>
            <a-select-option value="all">All projects</a-select-option>
            <a-select-option
              v-for="p in payload?.filters?.projects || []"
              :key="p"
              :value="p"
            >
              {{ p }}
            </a-select-option>
          </a-select>
          <a-input
            v-model:value="search"
            size="small"
            allow-clear
            placeholder="Search #IID or title"
            class="w-[200px]"
          >
            <template #prefix><SearchOutlined /></template>
          </a-input>
        </div>

        <a-spin :spinning="loading">
          <div v-if="payload" class="space-y-5">
            <ContributionHeatmap
              v-if="payload.heatmap?.length"
              :cells="payload.heatmap"
            />

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div class="rounded-xl border border-line bg-surface-raised/40 p-4">
                <div class="text-[11px] text-ink-muted uppercase tracking-wide">
                  Total tasks
                </div>
                <div class="text-2xl font-semibold text-ink mt-1">
                  {{ levelCounts.jobCount || 0 }}
                </div>
                <div class="text-xs mt-1" :class="pctClass(periodComparePct)">
                  {{ fmtPct(periodComparePct) }} {{ periodCompareLabel }}
                </div>
              </div>
              <div class="rounded-xl border border-line bg-surface-raised/40 p-4">
                <div class="text-[11px] text-ink-muted uppercase tracking-wide">
                  Completed
                </div>
                <div class="text-2xl font-semibold text-ink mt-1">
                  {{ levelCounts.succeeded || 0 }}
                </div>
                <div class="text-xs text-ink-muted mt-1">
                  {{
                    levelCounts.successRate != null
                      ? `${levelCounts.successRate}% success`
                      : "—"
                  }}
                  · ✗{{ levelCounts.failed || 0 }}
                  · pending {{ levelCounts.awaitingHandoff || 0 }}
                </div>
              </div>
              <div class="rounded-xl border border-line bg-surface-raised/40 p-4">
                <div class="text-[11px] text-ink-muted uppercase tracking-wide">
                  Avg tasks / day
                </div>
                <div class="text-2xl font-semibold text-ink mt-1">
                  {{ avgTasksPerDay }}
                </div>
                <div class="text-xs text-ink-muted mt-1">
                  {{ activeDayCount || payload.days }} days with data
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <Sparkline :values="levelCounts.spark || []" :width="180" :height="32" />
              <span class="text-[11px] text-ink-muted">Daily task trend</span>
            </div>

            <div class="text-sm text-ink">
              <button
                type="button"
                class="text-accent hover:underline bg-transparent border-0 p-0 cursor-pointer"
                @click="crumbRoot"
              >
                Months
              </button>
              <template v-if="currentMonth">
                <span class="text-ink-muted"> › </span>
                <button
                  type="button"
                  class="text-accent hover:underline bg-transparent border-0 p-0 cursor-pointer"
                  @click="crumbMonth"
                >
                  {{ monthCrumb(currentMonth.monthKey) }}
                </button>
              </template>
              <template v-if="currentWeek">
                <span class="text-ink-muted"> › </span>
                <span>{{ currentWeek.label }}</span>
              </template>
            </div>

            <div v-if="!drillMonth" class="space-y-2">
              <button
                v-for="m in months"
                :key="m.monthKey"
                type="button"
                class="stats-drill-card w-full text-left rounded-xl border border-line p-4 transition-colors"
                @click="openMonth(m)"
              >
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="font-medium text-ink">{{ m.label }}</div>
                    <div class="text-xs text-ink-muted mt-0.5">
                      {{ m.jobCount }} task · ✓{{ m.succeeded }} · ✗{{ m.failed }}
                      · pending {{ m.awaitingHandoff }}
                      <span v-if="m.successRate != null"> · {{ m.successRate }}%</span>
                    </div>
                  </div>
                  <Sparkline :values="m.spark || []" />
                </div>
              </button>
              <a-empty v-if="!months.length" description="No data yet" />
            </div>

            <div v-else-if="currentMonth && !drillWeek" class="space-y-2">
              <button
                v-for="w in currentMonth.weeks"
                :key="w.weekKey"
                type="button"
                class="stats-drill-card w-full text-left rounded-xl border border-line p-4 transition-colors"
                @click="openWeek(w)"
              >
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="font-medium text-ink">{{ w.label }}</div>
                    <div class="text-xs text-ink-muted mt-0.5">
                      {{ w.jobCount }} task · ✓{{ w.succeeded }} · ✗{{ w.failed }}
                      · pending {{ w.awaitingHandoff }}
                    </div>
                  </div>
                  <Sparkline :values="w.spark || []" />
                </div>
              </button>
            </div>

            <a-collapse
              v-else-if="visibleDays.length"
              accordion
              class="stats-collapse"
            >
              <a-collapse-panel
                v-for="d in visibleDays"
                :key="d.date"
                :header="`${ymdShort(d.date)} · ${d.jobCount || d.items?.length || 0} task · ✓${d.succeeded || 0} · ✗${d.failed || 0} · pending ${d.awaitingHandoff || 0}`"
              >
                <div
                  v-for="(it, idx) in d.items || []"
                  :key="it.jobId || idx"
                  class="py-1.5 text-sm text-ink-soft border-b border-line last:border-0"
                >
                  <IssueIidLink :iid="it.issueIid" :url="it.url" />
                  {{ it.title }}
                  <a-tag class="ml-2" :color="statusColor(it.status)">
                    {{ statusLabel(it.status) }}
                  </a-tag>
                </div>
              </a-collapse-panel>
            </a-collapse>

            <a-empty
              v-else-if="drillWeek && !visibleDays.length"
              description="No tasks this week"
            />

            <div
              v-if="displayTasks.length"
              class="rounded-xl border border-line bg-surface-raised/30 p-4"
            >
              <div class="text-sm font-medium text-ink mb-3">
                {{
                  search.trim()
                    ? `Matching tasks (${displayTasks.length}/${filteredTasks.length})`
                    : `Task list (${displayTasks.length}/${filteredTasks.length})`
                }}
              </div>
              <div
                v-for="it in displayTasks"
                :key="it.jobId"
                class="py-2 text-sm text-ink-soft border-b border-line last:border-0"
                :class="{
                  'bg-accent/10 -mx-2 px-2 rounded': highlightJobIds.has(it.jobId),
                }"
              >
                <span class="text-[11px] text-ink-muted font-mono mr-2">
                  {{ ymdShort((it.at || "").slice(0, 10)) }}
                </span>
                <IssueIidLink :iid="it.issueIid" :url="it.url" />
                {{ it.title }}
                <a-tag class="ml-2" :color="statusColor(it.status)">
                  {{ statusLabel(it.status) }}
                </a-tag>
                <div
                  v-if="it.status === 'failed' && it.error"
                  class="text-[11px] text-red-500 mt-0.5 ml-12"
                >
                  {{ it.error }}
                </div>
              </div>
              <div v-if="hasMoreTasks" class="pt-3 text-center">
                <a-button size="small" @click="loadMoreTasks">
                  Load more (+{{ LIST_PAGE }})
                </a-button>
              </div>
            </div>

            <div
              v-else-if="search.trim() && filteredTasks.length === 0"
              class="rounded-xl border border-line p-6 text-center text-ink-muted text-sm"
            >
              No tasks match "{{ search.trim() }}"
            </div>

            <div
              v-if="payload.failReasons?.length"
              class="rounded-xl border border-line bg-surface-raised/30 p-4"
            >
              <div class="text-sm font-medium text-ink mb-2">Fail reasons</div>
              <div
                v-for="r in payload.failReasons"
                :key="r.reason"
                class="flex justify-between text-xs py-0.5 text-ink-soft"
              >
                <span class="truncate pr-2">{{ r.reason }}</span>
                <span class="font-mono">{{ r.count }}</span>
              </div>
            </div>
          </div>
        </a-spin>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats-drill-card {
  background: rgb(var(--c-surface-raised) / 0.35);
  color: rgb(var(--c-ink));
}
.stats-drill-card:hover {
  background: rgb(var(--c-surface-soft));
  border-color: rgb(var(--c-accent) / 0.35);
}

.stats-collapse :deep(.ant-collapse) {
  background: transparent;
  border-color: rgb(var(--c-line));
}
.stats-collapse :deep(.ant-collapse-item) {
  border-color: rgb(var(--c-line)) !important;
  background: transparent;
}
.stats-collapse :deep(.ant-collapse-header) {
  background: rgb(var(--c-surface-raised) / 0.35) !important;
  color: rgb(var(--c-ink)) !important;
  border-radius: 8px !important;
}
.stats-collapse :deep(.ant-collapse-content) {
  background: transparent;
  border-color: rgb(var(--c-line));
  color: rgb(var(--c-ink-soft));
}
.stats-collapse :deep(.ant-collapse-content-box) {
  padding-top: 8px;
}
</style>
