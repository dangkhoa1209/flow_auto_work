<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";

type UsageBucket = {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costCents: number;
  costUsd: number;
  chargedUsd: number;
  estimatedUsd: number;
  sdkEvents: number;
};

type UserRow = UsageBucket & {
  userId: string;
  displayName?: string;
};

type KindRow = UsageBucket & { kind: string; label: string };
type DayRow = UsageBucket & { date: string };

type UsageEvent = {
  id: string;
  createdAt: string;
  kind: string;
  kindLabel: string;
  model: string | null;
  jobId: string | null;
  threadId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  costSource: string;
  fromSdk: boolean;
};

type UsagePayload = {
  timezone?: string;
  from?: string;
  to?: string;
  truncated?: boolean;
  userId?: string | null;
  kind?: string | null;
  kinds?: { id: string; label: string }[];
  totals?: UsageBucket;
  byUser?: UserRow[];
  byKind?: KindRow[];
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

const filteredUsers = computed(() => {
  const q = userSearch.value.trim().toLowerCase();
  const rows = payload.value?.byUser || [];
  if (!q) return rows;
  return rows.filter(
    (u) =>
      u.userId.includes(q) ||
      (u.displayName || "").toLowerCase().includes(q),
  );
});

const dayRows = computed(() => {
  const rows = selectedUser.value
    ? payload.value?.userDays || payload.value?.byDay || []
    : payload.value?.byDay || [];
  return [...rows].reverse().filter((d) => d.events > 0);
});

const userColumns = [
  { title: "User", key: "user", ellipsis: true },
  { title: "Runs", key: "events", width: 80, align: "right" as const },
  { title: "Tokens", key: "tokens", width: 150, align: "right" as const },
  { title: "Cost", key: "cost", width: 110, align: "right" as const },
  { title: "Billed", key: "sdk", width: 90, align: "right" as const },
];

const dayColumns = [
  { title: "Day", key: "date", width: 120 },
  { title: "Runs", key: "events", width: 80, align: "right" as const },
  { title: "Tokens", key: "tokens", width: 160, align: "right" as const },
  { title: "Cost", key: "cost", width: 110, align: "right" as const },
];

const eventColumns = [
  { title: "When", key: "when", width: 150 },
  { title: "Surface", key: "kind", width: 130 },
  { title: "Model", key: "model", ellipsis: true },
  { title: "Tokens", key: "tokens", width: 120, align: "right" as const },
  { title: "Cost", key: "cost", width: 100, align: "right" as const },
];

function fmtTokens(n: number | undefined): string {
  const v = n || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString("en-US");
}

function fmtUsd(n: number | undefined): string {
  return `$${(n || 0).toFixed(2)}`;
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

function buildQs(): string {
  const params = new URLSearchParams();
  if (customFrom.value && customTo.value) {
    params.set("from", customFrom.value);
    params.set("to", customTo.value);
  } else {
    params.set("days", String(daysPreset.value));
  }
  if (kindFilter.value) params.set("kind", kindFilter.value);
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

watch(
  [daysPreset, customFrom, customTo, kindFilter, selectedUser],
  () => {
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="faw-admin-page faw-admin-page--wide">
    <header class="faw-admin-page__head">
      <div>
        <h1 class="faw-admin-page__title">Cursor usage</h1>
        <p class="faw-admin-page__desc">
          Tokens and cost for BA Chat, Create issue, workflow, Work runs, Q&amp;A,
          QC testcases, and merge AI. Cost uses SDK billed cents when Cursor
          returns them; otherwise it is estimated from token rates.
        </p>
      </div>
    </header>

    <div class="flex flex-wrap gap-2 mb-4">
      <a-radio-group
        :value="customFrom ? 0 : daysPreset"
        size="small"
        @change="
          (e: { target?: { value?: number } } | number) =>
            applyPreset(typeof e === 'number' ? e : Number(e.target?.value))
        "
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
        v-model:value="kindFilter"
        allow-clear
        placeholder="All surfaces"
        size="small"
        class="min-w-[180px]"
        :options="kindOptions"
      />
    </div>

    <p class="text-xs text-ink-muted mb-3 m-0">
      {{ payload?.from }} → {{ payload?.to }}
      · {{ payload?.timezone }}
      <span v-if="payload?.truncated"> · truncated (too many events)</span>
    </p>

    <div class="faw-admin-stats">
      <div class="faw-admin-stat">
        <span class="faw-admin-stat__n">{{ payload?.totals?.events ?? 0 }}</span>
        <span class="faw-admin-stat__l">Runs</span>
      </div>
      <div class="faw-admin-stat">
        <span class="faw-admin-stat__n">{{
          fmtTokens(payload?.totals?.totalTokens)
        }}</span>
        <span class="faw-admin-stat__l">Tokens</span>
      </div>
      <div class="faw-admin-stat">
        <span class="faw-admin-stat__n">{{
          fmtUsd(payload?.totals?.costUsd)
        }}</span>
        <span class="faw-admin-stat__l">Cost (best available)</span>
      </div>
      <div class="faw-admin-stat faw-admin-stat--muted">
        <span class="faw-admin-stat__n">{{
          fmtUsd(payload?.totals?.chargedUsd)
        }}</span>
        <span class="faw-admin-stat__l">SDK billed</span>
      </div>
      <div class="faw-admin-stat faw-admin-stat--muted">
        <span class="faw-admin-stat__n">{{
          fmtUsd(payload?.totals?.estimatedUsd)
        }}</span>
        <span class="faw-admin-stat__l">Estimated</span>
      </div>
    </div>

    <div v-if="payload?.byKind?.length" class="flex flex-wrap gap-2 mb-4">
      <span
        v-for="k in payload.byKind"
        :key="k.kind"
        class="text-xs px-2 py-1 rounded-md border border-[var(--line)] bg-[var(--surface-raised)]"
      >
        {{ k.label }} · {{ fmtTokens(k.totalTokens) }} · {{ fmtUsd(k.costUsd) }}
      </span>
    </div>

    <div v-if="selectedUser" class="mb-3 flex items-center gap-2">
      <a-button size="small" @click="clearUser">All users</a-button>
      <span class="text-sm font-medium">@{{ selectedUser }}</span>
    </div>

    <a-input
      v-if="!selectedUser"
      v-model:value="userSearch"
      allow-clear
      placeholder="Filter users…"
      class="faw-admin-toolbar__search mb-3 max-w-xs"
    />

    <a-table
      v-if="!selectedUser"
      size="small"
      row-key="userId"
      :columns="userColumns"
      :data-source="filteredUsers"
      :loading="loading"
      :pagination="{ pageSize: 20, showSizeChanger: true }"
      :scroll="{ x: 720 }"
      :custom-row="
        (record: UserRow) => ({
          onClick: () => openUser(record),
          class: 'cursor-pointer',
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
          <div class="font-medium">@{{ record.userId }}</div>
          <div v-if="record.displayName" class="text-xs text-ink-muted">
            {{ record.displayName }}
          </div>
        </template>
        <template v-else-if="column.key === 'events'">{{ record.events }}</template>
        <template v-else-if="column.key === 'tokens'">
          {{ fmtTokens(record.totalTokens) }}
          <span class="text-ink-muted text-xs">
            ({{ fmtTokens(record.inputTokens) }} in /
            {{ fmtTokens(record.outputTokens) }} out)
          </span>
        </template>
        <template v-else-if="column.key === 'cost'">{{
          fmtUsd(record.costUsd)
        }}</template>
        <template v-else-if="column.key === 'sdk'">
          {{ record.sdkEvents }}/{{ record.events }}
        </template>
      </template>
    </a-table>

    <template v-if="selectedUser">
      <h2 class="text-sm font-semibold mt-2 mb-2">By day</h2>
      <a-table
        size="small"
        row-key="date"
        :columns="dayColumns"
        :data-source="dayRows"
        :loading="loading"
        :pagination="false"
        class="mb-6"
      >
        <template #emptyText>
          <div class="faw-admin-empty py-6">No usage on any day in range.</div>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'date'">{{ record.date }}</template>
          <template v-else-if="column.key === 'events'">{{ record.events }}</template>
          <template v-else-if="column.key === 'tokens'">
            {{ fmtTokens(record.totalTokens) }}
            <span class="text-ink-muted text-xs">
              ({{ fmtTokens(record.inputTokens) }} /
              {{ fmtTokens(record.outputTokens) }})
            </span>
          </template>
          <template v-else-if="column.key === 'cost'">{{
            fmtUsd(record.costUsd)
          }}</template>
        </template>
      </a-table>

      <h2 class="text-sm font-semibold mt-2 mb-2">Recent runs</h2>
      <a-table
        size="small"
        row-key="id"
        :columns="eventColumns"
        :data-source="payload?.events || []"
        :loading="loading"
        :pagination="{ pageSize: 20 }"
        :scroll="{ x: 760 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'when'">{{
            fmtWhen(record.createdAt)
          }}</template>
          <template v-else-if="column.key === 'kind'">{{
            record.kindLabel
          }}</template>
          <template v-else-if="column.key === 'model'">{{
            record.model || "—"
          }}</template>
          <template v-else-if="column.key === 'tokens'">{{
            fmtTokens(record.totalTokens)
          }}</template>
          <template v-else-if="column.key === 'cost'">
            {{ fmtUsd(record.costUsd) }}
            <span class="text-xs text-ink-muted">{{ record.costSource }}</span>
          </template>
        </template>
      </a-table>
    </template>
  </div>
</template>
