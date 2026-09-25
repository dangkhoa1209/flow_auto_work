<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import {
  ApiOutlined,
  BarChartOutlined,
  CloudSyncOutlined,
  KeyOutlined,
  MessageOutlined,
  RobotOutlined,
  TagOutlined,
  TeamOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { syncDbApi } from "@/api/syncDbApi";
import { useGreeting } from "@/composables/useGreeting";
import { useSessionStore } from "@/stores/session";
import { ADMIN_TABS } from "@/config/adminNav";

type UserRole = "dev" | "admin" | "qc" | "ba" | "pd" | "devops";

type AdminUser = {
  id: string;
  gitlabUsername: string;
  displayName?: string;
  roles: UserRole[];
  disabled: boolean;
  baChatMessageCount?: number;
  baChatThreadCount?: number;
  updatedAt: string;
};

type PasswordResetRequest = {
  id: string;
  username: string;
  note: string | null;
  requestedAt: string;
};

type UsageBucket = {
  events: number;
  totalTokens: number;
};

type DayRow = UsageBucket & { date: string };

type UsagePayload = {
  totals?: UsageBucket;
  byDay?: DayRow[];
  byKind?: { kind: string; label: string; events: number; totalTokens: number }[];
};

type CursorSettings = {
  hasCursorApiKey?: boolean;
  cursorPats?: { id: string; isActive: boolean; label: string }[];
  cursorModel?: string;
};

type BaFeaturesResponse = {
  flags: Record<string, "hide" | "lab" | "production">;
  devMode: boolean;
};

const ROLE_LABELS: Record<UserRole, string> = {
  dev: "Dev",
  admin: "Admin",
  qc: "QC",
  ba: "BA",
  pd: "PD",
  devops: "Build",
};

const ROLE_ORDER: UserRole[] = ["dev", "ba", "qc", "pd", "devops", "admin"];

const QUICK_ICONS = {
  users: TeamOutlined,
  usage: BarChartOutlined,
  chatbox: MessageOutlined,
  "ai-engine": RobotOutlined,
  "task-types": TagOutlined,
  "ba-features": ApiOutlined,
  "sync-db": CloudSyncOutlined,
} as const;

const session = useSessionStore();
const loading = ref(true);
const { greeting, displayName, todayLabel } = useGreeting("Admin");

const users = ref<AdminUser[]>([]);
const resetRequests = ref<PasswordResetRequest[]>([]);
const projectsCount = ref(0);
const usage = ref<UsagePayload | null>(null);
const cursor = ref<CursorSettings | null>(null);
const features = ref<BaFeaturesResponse | null>(null);
const syncEnabled = ref(false);
const syncConfigured = ref(false);

const userStats = computed(() => {
  const list = users.value;
  return {
    total: list.length,
    active: list.filter((u) => !u.disabled).length,
    disabled: list.filter((u) => u.disabled).length,
  };
});

const roleBreakdown = computed(() => {
  const counts: Record<UserRole, number> = {
    dev: 0,
    admin: 0,
    qc: 0,
    ba: 0,
    pd: 0,
    devops: 0,
  };
  for (const u of users.value) {
    if (u.disabled) continue;
    const role = (u.roles[0] || "dev") as UserRole;
    counts[role] = (counts[role] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return ROLE_ORDER.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    count: counts[role],
    pct: Math.round((counts[role] / total) * 100),
  })).filter((r) => r.count > 0);
});

const usageTotals = computed(() => usage.value?.totals || null);

const sparkDays = computed(() => {
  const days = [...(usage.value?.byDay || [])].slice(-14);
  const max = Math.max(1, ...days.map((d) => d.events || 0));
  return days.map((d) => ({
    date: d.date,
    events: d.events || 0,
    totalTokens: d.totalTokens || 0,
    height: Math.max(8, Math.round(((d.events || 0) / max) * 100)),
  }));
});

const topChatUsers = computed(() =>
  [...users.value]
    .filter((u) => !u.disabled && (u.baChatMessageCount ?? 0) > 0)
    .sort((a, b) => (b.baChatMessageCount ?? 0) - (a.baChatMessageCount ?? 0))
    .slice(0, 5),
);

const activePat = computed(() => {
  const pats = cursor.value?.cursorPats || [];
  return pats.find((p) => p.isActive) || null;
});

const featureSummary = computed(() => {
  const flags = features.value?.flags || {};
  const entries = Object.entries(flags);
  const production = entries.filter(([, v]) => v === "production").length;
  const lab = entries.filter(([, v]) => v === "lab").length;
  return { production, lab, total: entries.length };
});

const alerts = computed(() => {
  const items: {
    id: string;
    tone: "warn" | "info" | "ok";
    title: string;
    desc: string;
    to: string;
    cta: string;
  }[] = [];

  if (resetRequests.value.length) {
    items.push({
      id: "reset",
      tone: "warn",
      title: `${resetRequests.value.length} password reset request${resetRequests.value.length > 1 ? "s" : ""}`,
      desc: "Users asked for a new password from login.",
      to: "/admin/users",
      cta: "Review Users",
    });
  }

  if (!cursor.value?.hasCursorApiKey && !(cursor.value?.cursorPats?.length)) {
    items.push({
      id: "cursor",
      tone: "warn",
      title: "No shared Cursor API key",
      desc: "AI Engine will fail until a PAT is added.",
      to: "/admin/ai-engine",
      cta: "Open AI Engine",
    });
  } else if (!activePat.value && (cursor.value?.cursorPats?.length || 0) > 0) {
    items.push({
      id: "cursor-active",
      tone: "info",
      title: "No active Cursor key selected",
      desc: "Add or activate a shared PAT for agents.",
      to: "/admin/ai-engine",
      cta: "Open AI Engine",
    });
  }

  if (!syncConfigured.value) {
    items.push({
      id: "sync",
      tone: "info",
      title: "Sync DB not configured",
      desc: "SSH and source Mongo are required for database sync.",
      to: "/admin/sync-db",
      cta: "Configure Sync",
    });
  } else if (!syncEnabled.value) {
    items.push({
      id: "sync-off",
      tone: "info",
      title: "Sync DB is disabled",
      desc: "System config exists but sync is turned off.",
      to: "/admin/sync-db",
      cta: "Open Sync DB",
    });
  }

  if (features.value?.devMode) {
    items.push({
      id: "devmode",
      tone: "info",
      title: "ChatBox feature flags in dev mode",
      desc: "BA feature overrides may differ from production.",
      to: "/admin/ba-features",
      cta: "BA features",
    });
  }

  if (!items.length) {
    items.push({
      id: "ok",
      tone: "ok",
      title: "All systems look healthy",
      desc: "No pending password resets or critical config gaps.",
      to: "/admin/users",
      cta: "Manage Users",
    });
  }

  return items;
});

const quickLinks = computed(() =>
  ADMIN_TABS.filter((t) => t.id !== "dashboard").map((t) => ({
    ...t,
    icon: QUICK_ICONS[t.id as keyof typeof QUICK_ICONS] || TeamOutlined,
  })),
);

function formatTokens(n: number | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
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

async function load() {
  loading.value = true;
  try {
    const [usersData, resetData, projectsData, usageData, cursorData, featuresData, syncData] =
      await Promise.all([
        api<{ users?: AdminUser[] }>(API.admin.users).catch(() => ({ users: [] })),
        api<{ requests?: PasswordResetRequest[] }>(API.admin.passwordResetRequests).catch(
          () => ({ requests: [] as PasswordResetRequest[] }),
        ),
        api<{ projects?: unknown[] }>(API.admin.baProjects).catch(() => ({
          projects: [],
        })),
        api<UsagePayload>(`${API.admin.cursorUsage}?days=30`).catch(() => null),
        api<CursorSettings>(API.admin.cursorSettings).catch(() => null),
        api<BaFeaturesResponse>(API.admin.baFeatures).catch(() => null),
        syncDbApi.adminGetConfig().catch(() => null),
      ]);

    users.value = usersData.users || [];
    resetRequests.value = resetData.requests || [];
    projectsCount.value = projectsData.projects?.length || 0;
    usage.value = usageData;
    cursor.value = cursorData;
    features.value = featuresData;
    if (syncData?.config) {
      syncConfigured.value = Boolean(syncData.config.configured);
      syncEnabled.value = Boolean(syncData.config.enabled);
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="faw-admin-page faw-admin-page--wide faw-admin-dash">
    <header class="faw-admin-dash__hero">
      <div class="faw-admin-dash__hero-copy">
        <p class="faw-admin-dash__eyebrow">{{ todayLabel }}</p>
        <h1 class="faw-admin-dash__title">
          {{ greeting }}, {{ displayName }}
        </h1>
        <p class="faw-admin-dash__desc">
          Workspace health, AI usage, and shortcuts across the admin console.
        </p>
      </div>
      <a-button size="small" :loading="loading" @click="load">Refresh</a-button>
    </header>

    <section class="faw-admin-dash__kpis" aria-label="Key metrics">
      <div class="faw-admin-dash__kpi">
        <span class="faw-admin-dash__kpi-label">Active users</span>
        <span class="faw-admin-dash__kpi-value">{{ userStats.active }}</span>
        <span class="faw-admin-dash__kpi-meta">
          {{ userStats.total }} total · {{ userStats.disabled }} disabled
        </span>
      </div>
      <div
        class="faw-admin-dash__kpi"
        :class="{ 'is-alert': resetRequests.length > 0 }"
      >
        <span class="faw-admin-dash__kpi-label">Password resets</span>
        <span class="faw-admin-dash__kpi-value">{{ resetRequests.length }}</span>
        <span class="faw-admin-dash__kpi-meta">Pending from login</span>
      </div>
      <div class="faw-admin-dash__kpi">
        <span class="faw-admin-dash__kpi-label">Chatbox projects</span>
        <span class="faw-admin-dash__kpi-value">{{ projectsCount }}</span>
        <span class="faw-admin-dash__kpi-meta">BA project catalog</span>
      </div>
      <div class="faw-admin-dash__kpi">
        <span class="faw-admin-dash__kpi-label">AI tokens (30d)</span>
        <span class="faw-admin-dash__kpi-value">
          {{ formatTokens(usageTotals?.totalTokens) }}
        </span>
        <span class="faw-admin-dash__kpi-meta">
          {{ usageTotals?.events ?? 0 }} runs
        </span>
      </div>
      <div class="faw-admin-dash__kpi">
        <span class="faw-admin-dash__kpi-label">Cursor keys</span>
        <span class="faw-admin-dash__kpi-value">
          {{ cursor?.cursorPats?.length ?? 0 }}
        </span>
        <span class="faw-admin-dash__kpi-meta">
          <template v-if="activePat">Active: {{ activePat.label }}</template>
          <template v-else>No active key</template>
        </span>
      </div>
    </section>

    <section class="faw-admin-dash__grid">
      <div class="faw-admin-dash__col">
        <div class="faw-admin-dash__card">
          <div class="faw-admin-dash__card-head">
            <h2 class="faw-admin-dash__card-title">
              <WarningOutlined v-if="alerts[0]?.tone !== 'ok'" />
              Attention
            </h2>
          </div>
          <ul class="faw-admin-dash__alerts">
            <li
              v-for="a in alerts"
              :key="a.id"
              class="faw-admin-dash__alert"
              :class="`is-${a.tone}`"
            >
              <div class="faw-admin-dash__alert-copy">
                <strong>{{ a.title }}</strong>
                <p>{{ a.desc }}</p>
              </div>
              <RouterLink :to="a.to" class="faw-admin-dash__alert-cta">
                {{ a.cta }}
              </RouterLink>
            </li>
          </ul>
        </div>

        <div v-if="resetRequests.length" class="faw-admin-dash__card">
          <div class="faw-admin-dash__card-head">
            <h2 class="faw-admin-dash__card-title">Reset queue</h2>
            <RouterLink to="/admin/users" class="faw-admin-dash__link">
              Open Users
            </RouterLink>
          </div>
          <ul class="faw-admin-dash__queue">
            <li
              v-for="req in resetRequests.slice(0, 4)"
              :key="req.id"
              class="faw-admin-dash__queue-item"
            >
              <div>
                <span class="faw-admin-dash__queue-user">@{{ req.username }}</span>
                <p v-if="req.note" class="faw-admin-dash__queue-note">
                  {{ req.note }}
                </p>
              </div>
              <time class="faw-admin-dash__queue-time">
                {{ formatDateTime(req.requestedAt) }}
              </time>
            </li>
          </ul>
        </div>

        <div class="faw-admin-dash__card">
          <div class="faw-admin-dash__card-head">
            <h2 class="faw-admin-dash__card-title">Role mix</h2>
            <span class="faw-admin-dash__card-meta">Active accounts</span>
          </div>
          <div v-if="roleBreakdown.length" class="faw-admin-dash__roles">
            <div
              v-for="r in roleBreakdown"
              :key="r.role"
              class="faw-admin-dash__role"
            >
              <div class="faw-admin-dash__role-top">
                <span>{{ r.label }}</span>
                <span class="faw-admin-dash__role-count">{{ r.count }}</span>
              </div>
              <div class="faw-admin-dash__role-track" aria-hidden="true">
                <span
                  class="faw-admin-dash__role-fill"
                  :style="{ width: `${Math.max(r.pct, 4)}%` }"
                />
              </div>
            </div>
          </div>
          <p v-else class="faw-admin-dash__empty">No active users yet.</p>
        </div>
      </div>

      <div class="faw-admin-dash__col">
        <div class="faw-admin-dash__card">
          <div class="faw-admin-dash__card-head">
            <h2 class="faw-admin-dash__card-title">AI activity (14 days)</h2>
            <RouterLink to="/admin/usage" class="faw-admin-dash__link">
              Full usage
            </RouterLink>
          </div>
          <div v-if="sparkDays.length" class="faw-admin-dash__spark" role="img" aria-label="Daily AI runs">
            <div
              v-for="d in sparkDays"
              :key="d.date"
              class="faw-admin-dash__spark-col"
              :title="`${d.date}: ${d.events} runs · ${formatTokens(d.totalTokens)} tokens`"
            >
              <span
                class="faw-admin-dash__spark-bar"
                :style="{ height: `${d.height}%` }"
                :class="{ 'is-hot': d.events > 0 }"
              />
              <span class="faw-admin-dash__spark-label">{{ dayLabel(d.date) }}</span>
            </div>
          </div>
          <p v-else class="faw-admin-dash__empty">No usage data in this window.</p>
        </div>

        <div class="faw-admin-dash__card">
          <div class="faw-admin-dash__card-head">
            <h2 class="faw-admin-dash__card-title">System status</h2>
          </div>
          <ul class="faw-admin-dash__status">
            <li>
              <KeyOutlined />
              <div>
                <strong>AI Engine</strong>
                <p>
                  <template v-if="activePat">{{ activePat.label }} active</template>
                  <template v-else-if="cursor?.hasCursorApiKey">Key present</template>
                  <template v-else>Not configured</template>
                  <template v-if="cursor?.cursorModel">
                    · model {{ cursor.cursorModel }}
                  </template>
                </p>
              </div>
            </li>
            <li>
              <CloudSyncOutlined />
              <div>
                <strong>Sync DB</strong>
                <p>
                  <template v-if="!syncConfigured">Not configured</template>
                  <template v-else-if="syncEnabled">Enabled</template>
                  <template v-else>Configured · disabled</template>
                </p>
              </div>
            </li>
            <li>
              <ApiOutlined />
              <div>
                <strong>BA features</strong>
                <p>
                  {{ featureSummary.production }} production ·
                  {{ featureSummary.lab }} lab
                  <template v-if="features?.devMode"> · dev mode on</template>
                </p>
              </div>
            </li>
            <li>
              <MessageOutlined />
              <div>
                <strong>Project Chatbox</strong>
                <p>{{ projectsCount }} project{{ projectsCount === 1 ? "" : "s" }}</p>
              </div>
            </li>
          </ul>
        </div>

        <div v-if="topChatUsers.length" class="faw-admin-dash__card">
          <div class="faw-admin-dash__card-head">
            <h2 class="faw-admin-dash__card-title">Top Chatbox users</h2>
            <span class="faw-admin-dash__card-meta">By messages</span>
          </div>
          <ul class="faw-admin-dash__top">
            <li v-for="(u, i) in topChatUsers" :key="u.id">
              <span class="faw-admin-dash__top-rank">{{ i + 1 }}</span>
              <div class="faw-admin-dash__top-user">
                <strong>@{{ u.gitlabUsername }}</strong>
                <span v-if="u.displayName">{{ u.displayName }}</span>
              </div>
              <div class="faw-admin-dash__top-stats">
                <strong>{{ u.baChatMessageCount ?? 0 }}</strong>
                <span>msgs · {{ u.baChatThreadCount ?? 0 }} threads</span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section class="faw-admin-dash__card faw-admin-dash__card--links">
      <div class="faw-admin-dash__card-head">
        <h2 class="faw-admin-dash__card-title">Quick links</h2>
      </div>
      <div class="faw-admin-dash__links">
        <RouterLink
          v-for="link in quickLinks"
          :key="link.id"
          :to="link.to"
          class="faw-admin-dash__quick"
        >
          <span class="faw-admin-dash__quick-icon" aria-hidden="true">
            <component :is="link.icon" />
          </span>
          <span class="faw-admin-dash__quick-text">
            <strong>{{ link.label }}</strong>
            <span>{{ link.description }}</span>
          </span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>
