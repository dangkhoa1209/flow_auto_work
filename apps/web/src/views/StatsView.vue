<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import {
  BarChartOutlined,
  CloseCircleOutlined,
  DownloadOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
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

const activeFilters = computed(() => {
  const items: { key: string; label: string; clear: () => void }[] = [];
  if (statusFilter.value.length) {
    items.push({
      key: "status",
      label: `Status: ${statusFilter.value.join(", ")}`,
      clear: () => {
        statusFilter.value = [];
      },
    });
  }
  if (projectFilter.value !== "current") {
    const label =
      projectFilter.value === "all"
        ? "All projects"
        : projectFilter.value;
    items.push({
      key: "project",
      label: `Project: ${label}`,
      clear: () => {
        projectFilter.value = "current";
      },
    });
  }
  if (searchDebounced.value) {
    items.push({
      key: "q",
      label: `Search: ${searchDebounced.value}`,
      clear: () => {
        search.value = "";
      },
    });
  }
  if (customFrom.value && customTo.value) {
    items.push({
      key: "range",
      label: `${customFrom.value} → ${customTo.value}`,
      clear: () => {
        customFrom.value = undefined;
        customTo.value = undefined;
        daysPreset.value = 90;
        resetListPage();
        load();
      },
    });
  }
  return items;
});

function clearAllFilters() {
  statusFilter.value = [];
  projectFilter.value = "current";
  search.value = "";
  customFrom.value = undefined;
  customTo.value = undefined;
  daysPreset.value = 90;
  resetListPage();
  analysis.value = null;
  load();
}

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
  <div class="faw-stats-page">
    <div class="faw-stats-page__inner">
      <header class="faw-stats__hero">
        <div>
          <p class="faw-stats__eyebrow">
            <BarChartOutlined aria-hidden="true" />
            Dev analytics
          </p>
          <h1 class="faw-stats__title">Task stats</h1>
          <p class="faw-stats__desc">
            Track completed agent runs, success rate, and drill down by month, week,
            or day — filter by project and status.
          </p>
          <p v-if="payload?.from && payload?.to" class="faw-stats__range">
            {{ payload.from }} → {{ payload.to }}
            <span v-if="payload.timezone"> · {{ payload.timezone }}</span>
            <span v-if="session.me?.gitlabUsername || session.session.username">
              · @{{ session.me?.gitlabUsername || session.session.username }}
            </span>
            <span v-if="refreshing"> · refreshing…</span>
          </p>
        </div>
        <div class="faw-stats__hero-actions">
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
                ? "Analyzing…"
                : analysis
                  ? "Analyze again"
                  : "Analyze performance"
            }}
          </a-button>
          <a-button size="small" :loading="loading" @click="load()">
            <template #icon><ReloadOutlined /></template>
            Refresh
          </a-button>
          <a-button size="small" @click="exportCsv">
            <template #icon><DownloadOutlined /></template>
            Export CSV
          </a-button>
        </div>
      </header>

      <DevEvaluation
        v-if="analysis"
        :analysis="analysis"
        class="mb-4"
        @highlight-jobs="onHighlightJobs"
      />

      <div
        v-if="payload?.truncated"
        class="faw-stats__alert"
        role="status"
      >
        <WarningOutlined aria-hidden="true" />
        <div>
          <strong>Incomplete data</strong>
          <p>
            Showing {{ payload.returnedJobs }} / {{ payload.totalJobsInRange }}
            tasks in this range.
          </p>
        </div>
      </div>

      <section class="faw-stats__filters" aria-label="Filters">
        <div class="faw-stats__filters-row">
          <a-radio-group
            :value="customFrom ? 0 : daysPreset"
            size="small"
            @change="(e: { target?: { value?: number } } | number) => applyPreset(typeof e === 'number' ? e : Number(e.target?.value))"
          >
            <a-radio-button :value="7">7d</a-radio-button>
            <a-radio-button :value="30">30d</a-radio-button>
            <a-radio-button :value="90">90d</a-radio-button>
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
            class="faw-stats__select"
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
            class="faw-stats__select"
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
            class="faw-stats__search"
          >
            <template #prefix><SearchOutlined /></template>
          </a-input>
        </div>
        <div v-if="activeFilters.length" class="faw-stats__chips">
          <button
            v-for="f in activeFilters"
            :key="f.key"
            type="button"
            class="faw-stats__chip"
            @click="f.clear()"
          >
            {{ f.label }}
            <CloseCircleOutlined aria-hidden="true" />
          </button>
          <button
            type="button"
            class="faw-stats__chip faw-stats__chip--clear"
            @click="clearAllFilters"
          >
            Clear all
          </button>
        </div>
      </section>

      <a-spin :spinning="loading">
        <div v-if="payload">
          <ContributionHeatmap
            v-if="payload.heatmap?.length"
            :cells="payload.heatmap"
            class="mb-4"
          />

          <section class="faw-stats__kpis" aria-label="Summary metrics">
            <div class="faw-stats__kpi faw-stats__kpi--accent">
              <span class="faw-stats__kpi-label">Total tasks</span>
              <span class="faw-stats__kpi-value">{{
                levelCounts.jobCount || 0
              }}</span>
              <span
                class="faw-stats__kpi-meta"
                :class="{
                  'is-up': (periodComparePct ?? 0) > 0,
                  'is-down': (periodComparePct ?? 0) < 0,
                }"
              >
                {{ fmtPct(periodComparePct) }} {{ periodCompareLabel }}
              </span>
            </div>
            <div class="faw-stats__kpi">
              <span class="faw-stats__kpi-label">Completed</span>
              <span class="faw-stats__kpi-value">{{
                levelCounts.succeeded || 0
              }}</span>
              <span class="faw-stats__kpi-meta">
                {{
                  levelCounts.successRate != null
                    ? `${levelCounts.successRate}% success`
                    : "—"
                }}
                · ✗{{ levelCounts.failed || 0 }} · pending
                {{ levelCounts.awaitingHandoff || 0 }}
              </span>
            </div>
            <div class="faw-stats__kpi">
              <span class="faw-stats__kpi-label">Avg / day</span>
              <span class="faw-stats__kpi-value">{{ avgTasksPerDay }}</span>
              <span class="faw-stats__kpi-meta">
                {{ activeDayCount || payload.days }} days with data
              </span>
            </div>
            <div
              v-if="(payload.pendingHandoffCount || 0) > 0"
              class="faw-stats__kpi"
            >
              <span class="faw-stats__kpi-label">Pending handoff</span>
              <span class="faw-stats__kpi-value">{{
                payload.pendingHandoffCount
              }}</span>
              <span class="faw-stats__kpi-meta">Awaiting QC handoff</span>
            </div>
          </section>

          <div class="faw-stats__trend">
            <Sparkline
              :values="levelCounts.spark || []"
              :width="180"
              :height="32"
            />
            <span class="faw-stats__trend-label">Daily task trend</span>
          </div>

          <nav class="faw-stats__crumbs" aria-label="Drill-down">
            <button type="button" class="faw-stats__crumb" @click="crumbRoot">
              Months
            </button>
            <template v-if="currentMonth">
              <span class="faw-stats__crumb-sep">›</span>
              <button type="button" class="faw-stats__crumb" @click="crumbMonth">
                {{ monthCrumb(currentMonth.monthKey) }}
              </button>
            </template>
            <template v-if="currentWeek">
              <span class="faw-stats__crumb-sep">›</span>
              <span>{{ currentWeek.label }}</span>
            </template>
          </nav>

          <div v-if="!drillMonth">
            <button
              v-for="m in months"
              :key="m.monthKey"
              type="button"
              class="faw-stats__drill-card"
              @click="openMonth(m)"
            >
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="faw-stats__drill-title">{{ m.label }}</div>
                  <div class="faw-stats__drill-meta">
                    {{ m.jobCount }} task · ✓{{ m.succeeded }} · ✗{{ m.failed }}
                    · pending {{ m.awaitingHandoff }}
                    <span v-if="m.successRate != null">
                      · {{ m.successRate }}%</span
                    >
                  </div>
                </div>
                <Sparkline :values="m.spark || []" />
              </div>
            </button>
            <a-empty v-if="!months.length" description="No data yet" />
          </div>

          <div v-else-if="currentMonth && !drillWeek">
            <button
              v-for="w in currentMonth.weeks"
              :key="w.weekKey"
              type="button"
              class="faw-stats__drill-card"
              @click="openWeek(w)"
            >
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="faw-stats__drill-title">{{ w.label }}</div>
                  <div class="faw-stats__drill-meta">
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
            class="faw-stats-collapse"
          >
            <a-collapse-panel
              v-for="d in visibleDays"
              :key="d.date"
              :header="`${ymdShort(d.date)} · ${d.jobCount || d.items?.length || 0} task · ✓${d.succeeded || 0} · ✗${d.failed || 0} · pending ${d.awaitingHandoff || 0}`"
            >
              <div
                v-for="(it, idx) in d.items || []"
                :key="it.jobId || idx"
                class="faw-stats__task-row"
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

          <div v-if="displayTasks.length" class="faw-stats__card">
            <h2 class="faw-stats__card-title">
              {{
                search.trim()
                  ? `Matching tasks (${displayTasks.length}/${filteredTasks.length})`
                  : `Task list (${displayTasks.length}/${filteredTasks.length})`
              }}
            </h2>
            <div
              v-for="it in displayTasks"
              :key="it.jobId"
              class="faw-stats__task-row"
              :class="{ 'is-highlight': highlightJobIds.has(it.jobId) }"
            >
              <span class="faw-stats__task-date">
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
            class="faw-stats__empty-search"
          >
            No tasks match "{{ search.trim() }}"
          </div>

          <div v-if="payload.failReasons?.length" class="faw-stats__card">
            <h2 class="faw-stats__card-title">Fail reasons</h2>
            <div
              v-for="r in payload.failReasons"
              :key="r.reason"
              class="faw-stats__fail-row"
            >
              <span class="truncate pr-2">{{ r.reason }}</span>
              <span class="font-mono shrink-0">{{ r.count }}</span>
            </div>
          </div>
        </div>
      </a-spin>
    </div>
  </div>
</template>
