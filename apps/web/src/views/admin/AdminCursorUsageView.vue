<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  ArrowLeftOutlined,
  BarChartOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";

type UsageBucket = {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  errorEvents?: number;
  cancelledEvents?: number;
};

type UserRow = UsageBucket & {
  userId: string;
  displayName?: string;
  roles?: string[];
  roleLabels?: string[];
};

type KindRow = UsageBucket & { kind: string; label: string };
type RoleRow = UsageBucket & { role: string; label: string };
type DayRow = UsageBucket & { date: string };

type UsageEvent = {
  id: string;
  createdAt: string;
  kind: string;
  kindLabel: string;
  status?: string;
  statusLabel?: string;
  roles?: string[];
  roleLabels?: string[];
  userId?: string;
  displayName?: string;
  model: string | null;
  jobId: string | null;
  threadId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  fromSdk: boolean;
};

type UsagePayload = {
  timezone?: string;
  from?: string;
  to?: string;
  truncated?: boolean;
  userId?: string | null;
  kind?: string | null;
  role?: string | null;
  status?: string | null;
  kinds?: { id: string; label: string }[];
  roles?: { id: string; label: string }[];
  statuses?: { id: string; label: string }[];
  totals?: UsageBucket;
  byUser?: UserRow[];
  byKind?: KindRow[];
  byRole?: RoleRow[];
  byDay?: DayRow[];
  userDays?: DayRow[];
  events?: UsageEvent[];
};

const loading = ref(false);
const payload = ref<UsagePayload | null>(null);
const daysPreset = ref(30);
const customFrom = ref<string | undefined>();
const customTo = ref<string | undefined>();
const kindFilter = ref<string | undefined>(undefined);
const roleFilter = ref<string | undefined>(undefined);
const statusFilter = ref<string | undefined>(undefined);
const selectedUser = ref<string | null>(null);
const userSearch = ref("");

const rangeValue = computed(() => {
  if (customFrom.value && customTo.value) {
    return [customFrom.value, customTo.value];
  }
  return undefined;
});

const kindOptions = computed(() =>
  (payload.value?.kinds || []).map((k) => ({
    value: k.id,
    label: k.label,
  })),
);

const roleOptions = computed(() =>
  (payload.value?.roles || []).map((r) => ({
    value: r.id,
    label: r.label,
  })),
);

const statusOptions = computed(() =>
  (payload.value?.statuses || []).map((s) => ({
    value: s.id,
    label: s.label,
  })),
);

const filteredUsers = computed(() => {
  const q = userSearch.value.trim().toLowerCase();
  const rows = payload.value?.byUser || [];
  if (!q) return rows;
  return rows.filter(
    (u) =>
      u.userId.includes(q) ||
      (u.displayName || "").toLowerCase().includes(q) ||
      (u.roleLabels || []).some((l) => l.toLowerCase().includes(q)),
  );
});

const selectedUserMeta = computed(() => {
  if (!selectedUser.value) return null;
  return (
    payload.value?.byUser?.find((u) => u.userId === selectedUser.value) || {
      userId: selectedUser.value,
    }
  );
});

const dayRows = computed(() => {
  const rows = selectedUser.value
    ? payload.value?.userDays || payload.value?.byDay || []
    : payload.value?.byDay || [];
  return [...rows].reverse().filter((d) => d.events > 0);
});

const totals = computed(() => payload.value?.totals || null);

const successRate = computed(() => {
  const t = totals.value;
  if (!t?.events) return 100;
  const failed = (t.errorEvents ?? 0) + (t.cancelledEvents ?? 0);
  return Math.round(((t.events - failed) / t.events) * 100);
});

const tokenMix = computed(() => {
  const t = totals.value;
  if (!t) return [];
  const input = t.inputTokens || 0;
  const output = t.outputTokens || 0;
  const cache = (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0);
  const sum = input + output + cache || 1;
  return [
    { key: "input", label: "Input", tokens: input, pct: Math.round((input / sum) * 100) },
    { key: "output", label: "Output", tokens: output, pct: Math.round((output / sum) * 100) },
    { key: "cache", label: "Cache", tokens: cache, pct: Math.round((cache / sum) * 100) },
  ].filter((x) => x.tokens > 0);
});

const sparkDays = computed(() => {
  const days = [...(payload.value?.byDay || [])].slice(-14);
  const max = Math.max(1, ...days.map((d) => d.totalTokens || 0));
  return days.map((d) => ({
    date: d.date,
    events: d.events || 0,
    totalTokens: d.totalTokens || 0,
    height: Math.max(6, Math.round(((d.totalTokens || 0) / max) * 100)),
  }));
});

const roleBreakdown = computed(() => {
  const rows = payload.value?.byRole || [];
  const max = Math.max(1, ...rows.map((r) => r.totalTokens));
  return rows.slice(0, 8).map((r) => ({
    id: r.role,
    label: r.label,
    totalTokens: r.totalTokens,
    events: r.events,
    pct: Math.round((r.totalTokens / max) * 100),
  }));
});

const kindBreakdown = computed(() => {
  const rows = payload.value?.byKind || [];
  const max = Math.max(1, ...rows.map((r) => r.totalTokens));
  return rows.slice(0, 8).map((r) => ({
    id: r.kind,
    label: r.label,
    totalTokens: r.totalTokens,
    events: r.events,
    pct: Math.round((r.totalTokens / max) * 100),
  }));
});

const topUsers = computed(() => (payload.value?.byUser || []).slice(0, 5));

const activeFilters = computed(() => {
  const items: { key: string; label: string; clear: () => void }[] = [];
  if (kindFilter.value) {
    const label =
      payload.value?.kinds?.find((k) => k.id === kindFilter.value)?.label ||
      kindFilter.value;
    items.push({ key: "kind", label: `Surface: ${label}`, clear: () => { kindFilter.value = undefined; } });
  }
  if (roleFilter.value) {
    const label =
      payload.value?.roles?.find((r) => r.id === roleFilter.value)?.label ||
      roleFilter.value;
    items.push({ key: "role", label: `Role: ${label}`, clear: () => { roleFilter.value = undefined; } });
  }
  if (statusFilter.value) {
    const label =
      payload.value?.statuses?.find((s) => s.id === statusFilter.value)?.label ||
      statusFilter.value;
    items.push({ key: "status", label: `Status: ${label}`, clear: () => { statusFilter.value = undefined; } });
  }
  if (selectedUser.value) {
    items.push({
      key: "user",
      label: `@${selectedUser.value}`,
      clear: () => { selectedUser.value = null; },
    });
  }
  return items;
});

const rangeLabel = computed(() => {
  if (!payload.value?.from || !payload.value?.to) return "";
  return `${payload.value.from} → ${payload.value.to}`;
});

const userColumns = [
  { title: "User", key: "user", ellipsis: true },
  { title: "Roles", key: "roles", width: 120 },
  { title: "Runs", key: "events", width: 80, align: "right" as const },
  { title: "Tokens", key: "tokens", width: 170, align: "right" as const },
];

const dayColumns = [
  { title: "Day", key: "date", width: 120 },
  { title: "Runs", key: "events", width: 80, align: "right" as const },
  { title: "Tokens", key: "tokens", width: 180, align: "right" as const },
];

const eventColumns = [
  { title: "When", key: "when", width: 140 },
  { title: "User", key: "user", width: 120, ellipsis: true },
  { title: "Surface", key: "kind", width: 120 },
  { title: "Status", key: "status", width: 100 },
  { title: "Roles", key: "roles", width: 100 },
  { title: "Model", key: "model", ellipsis: true },
  { title: "Tokens", key: "tokens", width: 120, align: "right" as const },
];

function fmtTokens(n: number | undefined): string {
  const v = n || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString("en-US");
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    timeZone: payload.value?.timezone || "Asia/Ho_Chi_Minh",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(date: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "narrow" }).format(
      new Date(`${date}T12:00:00`),
    );
  } catch {
    return date.slice(-2);
  }
}

function statusClass(status?: string): string {
  if (status === "error") return "is-error";
  if (status === "cancelled") return "is-cancelled";
  return "is-ok";
}

function buildQs(): string {
  const params = new URLSearchParams();
  if (customFrom.value && customTo.value) {
    params.set("from", customFrom.value);
    params.set("to", customTo.value);
  } else {
    params.set("days", String(daysPreset.value));
  }
  if (kindFilter.value) params.set("kind", kindFilter.value);
  if (roleFilter.value) params.set("role", roleFilter.value);
  if (statusFilter.value) params.set("status", statusFilter.value);
  if (selectedUser.value) params.set("userId", selectedUser.value);
  const q = params.toString();
  return q ? `${API.admin.cursorUsage}?${q}` : API.admin.cursorUsage;
}

async function load() {
  loading.value = true;
  try {
    payload.value = await api<UsagePayload>(buildQs());
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function applyPreset(n: number) {
  if (!n) return;
  daysPreset.value = n;
  customFrom.value = undefined;
  customTo.value = undefined;
}

function applyCustomRange(strings: string[] | string) {
  const arr = Array.isArray(strings) ? strings : [];
  if (arr.length === 2 && arr[0] && arr[1]) {
    customFrom.value = arr[0];
    customTo.value = arr[1];
  }
}

function openUser(row: UserRow) {
  selectedUser.value = row.userId;
}

function clearUser() {
  selectedUser.value = null;
}

function clearAllFilters() {
  kindFilter.value = undefined;
  roleFilter.value = undefined;
  statusFilter.value = undefined;
  selectedUser.value = null;
}

function toggleKind(kind: string) {
  kindFilter.value = kindFilter.value === kind ? undefined : kind;
}

function toggleRole(role: string) {
  roleFilter.value = roleFilter.value === role ? undefined : role;
}

watch(
  [daysPreset, customFrom, customTo, kindFilter, roleFilter, statusFilter, selectedUser],
  () => {
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="faw-admin-page faw-admin-page--wide faw-admin-usage">
    <header class="faw-admin-usage__hero">
      <div class="faw-admin-usage__hero-copy">
        <p class="faw-admin-usage__eyebrow">
          <BarChartOutlined aria-hidden="true" />
          Cursor analytics
        </p>
        <h1 class="faw-admin-usage__title">Token usage</h1>
        <p class="faw-admin-usage__desc">
          Every Cursor agent run across BA, Dev, QC, DevOps, and PD — tokens only,
          no billing. Drill into users, surfaces, and daily trends.
        </p>
        <p v-if="rangeLabel" class="faw-admin-usage__range">
          {{ rangeLabel }}
          <span v-if="payload?.timezone"> · {{ payload.timezone }}</span>
        </p>
      </div>
      <a-button
        size="small"
        :loading="loading"
        class="faw-admin-usage__refresh"
        @click="load"
      >
        <template #icon><ReloadOutlined /></template>
        Refresh
      </a-button>
    </header>

    <div
      v-if="payload?.truncated"
      class="faw-admin-usage__alert"
      role="status"
    >
      <WarningOutlined aria-hidden="true" />
      <div>
        <strong>Dataset truncated</strong>
        <p>Too many events in this window — totals reflect scanned rows only.</p>
      </div>
    </div>

    <section class="faw-admin-usage__filters" aria-label="Filters">
      <div class="faw-admin-usage__filters-row">
        <a-radio-group
          :value="customFrom ? 0 : daysPreset"
          size="small"
          @change="
            (e: { target?: { value?: number } } | number) =>
              applyPreset(typeof e === 'number' ? e : Number(e.target?.value))
          "
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
          v-model:value="kindFilter"
          allow-clear
          placeholder="All surfaces"
          size="small"
          class="faw-admin-usage__select"
          :options="kindOptions"
        />
        <a-select
          v-model:value="roleFilter"
          allow-clear
          placeholder="All roles"
          size="small"
          class="faw-admin-usage__select faw-admin-usage__select--sm"
          :options="roleOptions"
        />
        <a-select
          v-model:value="statusFilter"
          allow-clear
          placeholder="All statuses"
          size="small"
          class="faw-admin-usage__select faw-admin-usage__select--sm"
          :options="statusOptions"
        />
      </div>
      <div v-if="activeFilters.length" class="faw-admin-usage__chips">
        <button
          v-for="f in activeFilters"
          :key="f.key"
          type="button"
          class="faw-admin-usage__chip"
          @click="f.clear()"
        >
          {{ f.label }}
          <CloseCircleOutlined aria-hidden="true" />
        </button>
        <button
          type="button"
          class="faw-admin-usage__chip faw-admin-usage__chip--clear"
          @click="clearAllFilters"
        >
          Clear all
        </button>
      </div>
    </section>

    <section class="faw-admin-usage__kpis" aria-label="Summary metrics">
      <div class="faw-admin-usage__kpi">
        <span class="faw-admin-usage__kpi-label">Agent runs</span>
        <span class="faw-admin-usage__kpi-value">{{ totals?.events ?? 0 }}</span>
        <span class="faw-admin-usage__kpi-meta">LLM invocations</span>
      </div>
      <div class="faw-admin-usage__kpi faw-admin-usage__kpi--accent">
        <span class="faw-admin-usage__kpi-label">Total tokens</span>
        <span class="faw-admin-usage__kpi-value">{{
          fmtTokens(totals?.totalTokens)
        }}</span>
        <span class="faw-admin-usage__kpi-meta">
          {{ fmtTokens(totals?.inputTokens) }} in ·
          {{ fmtTokens(totals?.outputTokens) }} out
        </span>
      </div>
      <div class="faw-admin-usage__kpi">
        <span class="faw-admin-usage__kpi-label">Success rate</span>
        <span class="faw-admin-usage__kpi-value">{{ successRate }}%</span>
        <span class="faw-admin-usage__kpi-meta">Completed without error</span>
      </div>
      <div
        class="faw-admin-usage__kpi"
        :class="{ 'faw-admin-usage__kpi--warn': (totals?.errorEvents ?? 0) + (totals?.cancelledEvents ?? 0) > 0 }"
      >
        <span class="faw-admin-usage__kpi-label">Failed / cancelled</span>
        <span class="faw-admin-usage__kpi-value">{{
          (totals?.errorEvents ?? 0) + (totals?.cancelledEvents ?? 0)
        }}</span>
        <span class="faw-admin-usage__kpi-meta">
          {{ totals?.errorEvents ?? 0 }} errors ·
          {{ totals?.cancelledEvents ?? 0 }} cancelled
        </span>
      </div>
      <div class="faw-admin-usage__kpi">
        <span class="faw-admin-usage__kpi-label">Active users</span>
        <span class="faw-admin-usage__kpi-value">{{
          payload?.byUser?.length ?? 0
        }}</span>
        <span class="faw-admin-usage__kpi-meta">With usage in range</span>
      </div>
    </section>

    <section v-if="tokenMix.length" class="faw-admin-usage__mix" aria-label="Token mix">
      <div class="faw-admin-usage__mix-head">
        <span class="faw-admin-usage__mix-title">Token mix</span>
        <span class="faw-admin-usage__mix-meta">Input · output · cache</span>
      </div>
      <div class="faw-admin-usage__mix-bar" role="img" :aria-label="tokenMix.map((t) => `${t.label} ${t.pct}%`).join(', ')">
        <span
          v-for="seg in tokenMix"
          :key="seg.key"
          class="faw-admin-usage__mix-seg"
          :class="`is-${seg.key}`"
          :style="{ width: `${Math.max(seg.pct, 2)}%` }"
          :title="`${seg.label}: ${fmtTokens(seg.tokens)} (${seg.pct}%)`"
        />
      </div>
      <ul class="faw-admin-usage__mix-legend">
        <li v-for="seg in tokenMix" :key="seg.key">
          <span class="faw-admin-usage__mix-dot" :class="`is-${seg.key}`" />
          {{ seg.label }}
          <strong>{{ fmtTokens(seg.tokens) }}</strong>
          <span class="faw-admin-usage__mix-pct">{{ seg.pct }}%</span>
        </li>
      </ul>
    </section>

    <section class="faw-admin-usage__grid">
      <div class="faw-admin-usage__card">
        <div class="faw-admin-usage__card-head">
          <h2 class="faw-admin-usage__card-title">Daily tokens (14d)</h2>
          <span class="faw-admin-usage__card-meta">Bar height = tokens</span>
        </div>
        <div
          v-if="sparkDays.length"
          class="faw-admin-dash__spark faw-admin-usage__spark"
          role="img"
          aria-label="Daily token usage"
        >
          <div
            v-for="d in sparkDays"
            :key="d.date"
            class="faw-admin-dash__spark-col"
            :title="`${d.date}: ${d.events} runs · ${fmtTokens(d.totalTokens)} tokens`"
          >
            <span
              class="faw-admin-dash__spark-bar"
              :style="{ height: `${d.height}%` }"
              :class="{ 'is-hot': d.totalTokens > 0 }"
            />
            <span class="faw-admin-dash__spark-label">{{ dayLabel(d.date) }}</span>
          </div>
        </div>
        <p v-else class="faw-admin-usage__empty">No daily data in this window.</p>
      </div>

      <div class="faw-admin-usage__card">
        <div class="faw-admin-usage__card-head">
          <h2 class="faw-admin-usage__card-title">By role</h2>
          <span class="faw-admin-usage__card-meta">Click to filter</span>
        </div>
        <div v-if="roleBreakdown.length" class="faw-admin-usage__bars">
          <button
            v-for="r in roleBreakdown"
            :key="r.id"
            type="button"
            class="faw-admin-usage__bar-row"
            :class="{ 'is-active': roleFilter === r.id }"
            @click="toggleRole(r.id)"
          >
            <div class="faw-admin-usage__bar-top">
              <span>{{ r.label }}</span>
              <span class="faw-admin-usage__bar-val">{{ fmtTokens(r.totalTokens) }}</span>
            </div>
            <div class="faw-admin-usage__bar-track" aria-hidden="true">
              <span class="faw-admin-usage__bar-fill" :style="{ width: `${Math.max(r.pct, 4)}%` }" />
            </div>
          </button>
        </div>
        <p v-else class="faw-admin-usage__empty">No role breakdown yet.</p>
      </div>

      <div class="faw-admin-usage__card">
        <div class="faw-admin-usage__card-head">
          <h2 class="faw-admin-usage__card-title">By surface</h2>
          <span class="faw-admin-usage__card-meta">BA · Dev · QC flows</span>
        </div>
        <div v-if="kindBreakdown.length" class="faw-admin-usage__bars">
          <button
            v-for="k in kindBreakdown"
            :key="k.id"
            type="button"
            class="faw-admin-usage__bar-row"
            :class="{ 'is-active': kindFilter === k.id }"
            @click="toggleKind(k.id)"
          >
            <div class="faw-admin-usage__bar-top">
              <span>{{ k.label }}</span>
              <span class="faw-admin-usage__bar-val">{{ fmtTokens(k.totalTokens) }}</span>
            </div>
            <div class="faw-admin-usage__bar-track" aria-hidden="true">
              <span
                class="faw-admin-usage__bar-fill faw-admin-usage__bar-fill--kind"
                :style="{ width: `${Math.max(k.pct, 4)}%` }"
              />
            </div>
          </button>
        </div>
        <p v-else class="faw-admin-usage__empty">No surface data yet.</p>
      </div>

      <div v-if="!selectedUser && topUsers.length" class="faw-admin-usage__card">
        <div class="faw-admin-usage__card-head">
          <h2 class="faw-admin-usage__card-title">Top users</h2>
          <span class="faw-admin-usage__card-meta">By tokens</span>
        </div>
        <ul class="faw-admin-usage__top">
          <li v-for="(u, i) in topUsers" :key="u.userId">
            <span class="faw-admin-usage__top-rank">{{ i + 1 }}</span>
            <button
              type="button"
              class="faw-admin-usage__top-user"
              @click="openUser(u)"
            >
              <strong>@{{ u.userId }}</strong>
              <span v-if="u.displayName">{{ u.displayName }}</span>
            </button>
            <div class="faw-admin-usage__top-stats">
              <strong>{{ fmtTokens(u.totalTokens) }}</strong>
              <span>{{ u.events }} runs</span>
            </div>
          </li>
        </ul>
      </div>
    </section>

    <section v-if="selectedUser" class="faw-admin-usage__user-banner">
      <button type="button" class="faw-admin-usage__back" @click="clearUser">
        <ArrowLeftOutlined aria-hidden="true" />
        All users
      </button>
      <div class="faw-admin-usage__user-banner-copy">
        <strong>@{{ selectedUserMeta?.userId }}</strong>
        <span v-if="selectedUserMeta?.displayName">{{
          selectedUserMeta.displayName
        }}</span>
        <span v-if="selectedUserMeta?.roleLabels?.length" class="faw-admin-usage__user-roles">
          {{ selectedUserMeta.roleLabels.join(" · ") }}
        </span>
      </div>
      <div class="faw-admin-usage__user-banner-stats">
        <span>{{ selectedUserMeta?.events ?? 0 }} runs</span>
        <strong>{{ fmtTokens(selectedUserMeta?.totalTokens) }}</strong>
      </div>
    </section>

    <section
      v-if="!selectedUser"
      class="faw-admin-usage__card faw-admin-usage__card--table"
    >
      <div class="faw-admin-usage__card-head">
        <h2 class="faw-admin-usage__card-title">All users</h2>
        <a-input
          v-model:value="userSearch"
          allow-clear
          placeholder="Search users…"
          size="small"
          class="faw-admin-usage__search"
        />
      </div>
      <a-table
        size="small"
        row-key="userId"
        class="faw-admin-usage-table"
        :columns="userColumns"
        :data-source="filteredUsers"
        :loading="loading"
        :pagination="{ pageSize: 20, showSizeChanger: true, size: 'small' }"
        :scroll="{ x: 720 }"
        :custom-row="
          (record: UserRow) => ({
            onClick: () => openUser(record),
            class: 'faw-admin-usage-table__row--click',
          })
        "
      >
        <template #emptyText>
          <div class="faw-admin-empty py-8">
            <p class="mb-0">No Cursor usage in this range yet.</p>
          </div>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'user'">
            <div class="faw-admin-user-cell__name">@{{ record.userId }}</div>
            <div v-if="record.displayName" class="faw-admin-user-cell__sub">
              {{ record.displayName }}
            </div>
          </template>
          <template v-else-if="column.key === 'roles'">
            <span class="text-xs text-ink-muted">{{
              (record.roleLabels || []).join(", ") || "—"
            }}</span>
          </template>
          <template v-else-if="column.key === 'events'">{{ record.events }}</template>
          <template v-else-if="column.key === 'tokens'">
            <span class="faw-admin-usage__mono">{{ fmtTokens(record.totalTokens) }}</span>
            <span class="faw-admin-usage__sub">
              {{ fmtTokens(record.inputTokens) }} in /
              {{ fmtTokens(record.outputTokens) }} out
            </span>
          </template>
        </template>
      </a-table>
    </section>

    <section
      v-if="selectedUser"
      class="faw-admin-usage__card faw-admin-usage__card--table"
    >
      <div class="faw-admin-usage__card-head">
        <h2 class="faw-admin-usage__card-title">Daily breakdown</h2>
      </div>
      <a-table
        size="small"
        row-key="date"
        class="faw-admin-usage-table"
        :columns="dayColumns"
        :data-source="dayRows"
        :loading="loading"
        :pagination="false"
      >
        <template #emptyText>
          <div class="faw-admin-empty py-6">No usage on any day in range.</div>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'date'">
            <span class="faw-admin-usage__mono">{{ record.date }}</span>
          </template>
          <template v-else-if="column.key === 'events'">{{ record.events }}</template>
          <template v-else-if="column.key === 'tokens'">
            <span class="faw-admin-usage__mono">{{ fmtTokens(record.totalTokens) }}</span>
            <span class="faw-admin-usage__sub">
              {{ fmtTokens(record.inputTokens) }} /
              {{ fmtTokens(record.outputTokens) }}
            </span>
          </template>
        </template>
      </a-table>
    </section>

    <section class="faw-admin-usage__card faw-admin-usage__card--table">
      <div class="faw-admin-usage__card-head">
        <h2 class="faw-admin-usage__card-title">
          {{ selectedUser ? "Recent runs" : "Recent history" }}
        </h2>
        <span class="faw-admin-usage__card-meta">Latest 200 events</span>
      </div>
      <a-table
        size="small"
        row-key="id"
        class="faw-admin-usage-table"
        :columns="eventColumns"
        :data-source="payload?.events || []"
        :loading="loading"
        :pagination="{ pageSize: 25, showSizeChanger: true, size: 'small' }"
        :scroll="{ x: 920 }"
      >
        <template #emptyText>
          <div class="faw-admin-empty py-6">No runs recorded yet.</div>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'when'">
            <span class="faw-admin-usage__mono">{{ fmtWhen(record.createdAt) }}</span>
          </template>
          <template v-else-if="column.key === 'user'">
            <button
              v-if="record.userId && !selectedUser"
              type="button"
              class="faw-admin-usage__link-user"
              @click.stop="selectedUser = record.userId"
            >
              @{{ record.userId }}
            </button>
            <span v-else class="text-xs">@{{ record.userId || "—" }}</span>
            <div v-if="record.displayName" class="faw-admin-user-cell__sub">
              {{ record.displayName }}
            </div>
          </template>
          <template v-else-if="column.key === 'kind'">
            <span class="faw-admin-usage__surface">{{ record.kindLabel }}</span>
          </template>
          <template v-else-if="column.key === 'status'">
            <span
              class="faw-admin-usage__status"
              :class="statusClass(record.status)"
            >
              {{ record.statusLabel || record.status || "OK" }}
            </span>
          </template>
          <template v-else-if="column.key === 'roles'">
            <span class="text-xs text-ink-muted">{{
              (record.roleLabels || []).join(", ") || "—"
            }}</span>
          </template>
          <template v-else-if="column.key === 'model'">
            <span class="faw-admin-usage__model">{{ record.model || "—" }}</span>
            <span
              v-if="!record.fromSdk"
              class="faw-admin-usage__est"
              title="Estimated from character count"
            >est.</span>
          </template>
          <template v-else-if="column.key === 'tokens'">
            <span class="faw-admin-usage__mono">{{ fmtTokens(record.totalTokens) }}</span>
          </template>
        </template>
      </a-table>
    </section>
  </div>
</template>
