<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import { SettingOutlined } from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useWorkStore } from "@/stores/work";
import { connectRealtime } from "@/realtime/client";
import MobileBottomNav from "@/components/MobileBottomNav.vue";

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const work = useWorkStore();
const settings = useSettingsStore();

const nav = [
  { to: "/work", label: "Work" },
  { to: "/handoff", label: "Handoff" },
  { to: "/stats", label: "Stats" },
];

const switching = ref(false);
const selectedProjectId = ref(session.session.projectId || "");

watch(
  () => session.session.projectId,
  (id) => {
    if (id && id !== selectedProjectId.value) selectedProjectId.value = id;
  },
);

const projectOptions = computed(() =>
  session.memberships.map((m) => {
    const p = m.project;
    const flowName = (p?.projectName || p?.displayName || "").trim();
    const gitlabPath = (p?.gitlabPath || "").trim();
    const label =
      gitlabPath && flowName
        ? `${gitlabPath} > ${flowName}`
        : gitlabPath || flowName || m.projectId;
    return {
      value: m.projectId,
      label,
      gitlabPath: gitlabPath || "—",
      flowName: flowName || m.projectId,
    };
  }),
);

const activeProject = computed(() => {
  const id = selectedProjectId.value || session.session.projectId;
  return projectOptions.value.find((o) => o.value === id) || null;
});

const idleDot = computed(() => {
  const t = (work.statusText || "").toLowerCase();
  if (t.startsWith("running") || t.startsWith("queue")) return "wip";
  return "idle";
});

let disconnectRealtime: (() => void) | undefined;

onMounted(async () => {
  selectedProjectId.value = session.session.projectId || "";
  try {
    await work.refreshAll();
    await settings.loadHandoffPrefs(session.projectId);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
  disconnectRealtime = connectRealtime({
    onStatus: (ev) => {
      work.applyStatusSnapshot({
        currentJobId: ev.currentJobId,
        currentJobIds: ev.currentJobIds,
        queueLength: ev.queueLength,
      });
    },
    onProgress: (ev) => work.applyRealtimeProgress(ev),
    onJobs: () => work.scheduleLoadJobs(),
    onJob: (ev) => work.applyRealtimeJob(ev),
    onChat: (ev) => work.applyRealtimeChat(ev),
  });
});

onUnmounted(() => {
  disconnectRealtime?.();
});

async function onSwitchProject(projectId: string) {
  if (!projectId || projectId === session.session.projectId) return;
  switching.value = true;
  try {
    await session.activateProject(projectId);
    selectedProjectId.value = projectId;
    await work.refreshAll();
    await settings.loadHandoffPrefs(projectId);
    message.success("Project switched");
  } catch (e) {
    selectedProjectId.value = session.session.projectId || "";
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    switching.value = false;
  }
}

function goManageProjects() {
  router.push("/settings/project");
}

async function onKillAll() {
  try {
    const res = await work.killAllJobs();
    message.success(
      res.killed > 0
        ? `Stopped ${res.killed} job${res.killed === 1 ? "" : "s"}`
        : "No active jobs to stop",
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden overflow-x-hidden bg-[var(--app-bg)]">
    <header class="faw-topbar">
      <RouterLink to="/work" class="faw-brand" title="Flow Auto WorkBench">
        <img
          class="faw-brand__logo"
          src="/logo.svg"
          alt="Flow Auto WorkBench"
          width="148"
          height="33"
          draggable="false"
        />
      </RouterLink>

      <div class="faw-crumb">
        <a-select
          v-model:value="selectedProjectId"
          class="faw-crumb-select"
          :bordered="false"
          :loading="switching"
          :disabled="switching || !projectOptions.length"
          show-search
          option-filter-prop="label"
          option-label-prop="label"
          placeholder="Select project"
          @change="(v: string) => onSwitchProject(v)"
        >
          <a-select-option
            v-for="o in projectOptions"
            :key="o.value"
            :value="o.value"
            :label="`${o.gitlabPath} › ${o.flowName}`"
          >
            <span class="font-mono text-[11px] text-ink-faint">{{
              o.gitlabPath
            }}</span>
            <span class="text-ink-faint mx-1">›</span>
            <b class="text-ink font-semibold">{{ o.flowName }}</b>
          </a-select-option>
        </a-select>
      </div>

      <nav class="faw-seg hidden lg:flex">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="faw-seg__btn"
          :class="{ active: route.path.startsWith(item.to) }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="faw-topbar__spacer" />

      <div class="faw-topbar__right hidden lg:flex">
        <span class="faw-idle">
          <span class="faw-idle__dot" :class="idleDot" />
          {{ work.statusText || "Idle" }}
        </span>
        <a-popconfirm
          v-if="work.canKillAll"
          title="Stop all running and queued jobs?"
          ok-text="Kill all"
          cancel-text="Cancel"
          ok-type="danger"
          @confirm="onKillAll"
        >
          <button
            type="button"
            class="faw-btn faw-btn--danger"
            :disabled="work.killAllBusy"
            title="Force stop all active jobs"
          >
            {{ work.killAllBusy ? "Stopping…" : "Kill all" }}
          </button>
        </a-popconfirm>
        <div class="faw-user-chip">
          <span class="faw-avatar" />
          @{{ session.session.username }}
        </div>
        <button
          type="button"
          class="faw-icon-btn"
          title="Settings"
          @click="router.push('/settings')"
        >
          <SettingOutlined />
        </button>
        <button
          type="button"
          class="faw-icon-btn"
          title="Manage projects"
          @click="goManageProjects"
        >
          +
        </button>
      </div>
    </header>

    <main
      class="flex-1 min-h-0 overflow-hidden overflow-x-hidden pb-[calc(3.25rem+env(safe-area-inset-bottom))] lg:pb-0"
    >
      <RouterView />
    </main>

    <MobileBottomNav />
  </div>
</template>
