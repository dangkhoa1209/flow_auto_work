<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import {
  ThunderboltOutlined,
  ProjectOutlined,
  PlusOutlined,
} from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import { useWorkStore } from "@/stores/work";
import { connectRealtime } from "@/realtime/client";

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const work = useWorkStore();

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
    const name = (p.displayName || p.projectName || "").trim();
    const path = (p.gitlabPath || "").trim();
    const label =
      path && name ? `${path} > ${name}` : path || name || m.projectId;
    return {
      value: m.projectId,
      label,
    };
  }),
);

let disconnectRealtime: (() => void) | undefined;

onMounted(async () => {
  selectedProjectId.value = session.session.projectId || "";
  try {
    await work.refreshAll();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
  disconnectRealtime = connectRealtime({
    onStatus: (ev) => {
      work.applyStatusSnapshot({
        currentJobId: ev.currentJobId,
        queueLength: ev.queueLength,
      });
    },
    onProgress: (ev) => work.applyRealtimeProgress(ev),
    onJobs: () => work.scheduleLoadJobs(),
    onJob: (ev) => work.applyRealtimeJob(ev),
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
    message.success("Đã chuyển project");
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
</script>

<template>
  <div class="h-full max-h-full flex flex-col overflow-hidden">
    <header
      class="shrink-0 border-b border-line bg-surface-raised/85 backdrop-blur-md px-2.5 sm:px-4 py-2 sm:py-2.5 flex items-center gap-2 sm:gap-3 shadow-sm"
    >
      <div class="flex items-center gap-2 min-w-0 shrink-0">
        <div
          class="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-accent-bright to-sky-500 text-white shadow-sm"
        >
          <ThunderboltOutlined class="text-sm" />
        </div>
        <div class="min-w-0 hidden md:block">
          <div class="font-semibold tracking-tight brand-mark leading-tight">
            Flow Auto Work
          </div>
        </div>
      </div>

      <div
        class="flex items-center gap-1 sm:gap-1.5 min-w-0 flex-1 max-w-none sm:max-w-md lg:max-w-lg"
      >
        <ProjectOutlined class="text-ink-faint shrink-0 hidden sm:inline" />
        <a-select
          v-model:value="selectedProjectId"
          class="w-full min-w-0"
          placeholder="Project"
          :loading="switching"
          :options="projectOptions"
          :disabled="switching || !projectOptions.length"
          show-search
          option-filter-prop="label"
          @change="(v: string) => onSwitchProject(v)"
        />
        <a-tooltip title="Tạo project">
          <a-button type="text" class="shrink-0" @click="goManageProjects">
            <template #icon><PlusOutlined /></template>
          </a-button>
        </a-tooltip>
      </div>

      <nav
        class="flex items-center gap-0.5 sm:gap-1 p-0.5 sm:p-1 rounded-xl bg-surface-muted/80 shrink-0 overflow-x-auto max-w-[42vw] sm:max-w-none"
      >
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm text-ink-muted hover:text-ink hover:bg-surface-raised transition whitespace-nowrap"
          :class="
            route.path.startsWith(item.to)
              ? '!text-accent !bg-surface-raised font-semibold shadow-sm'
              : ''
          "
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="ml-auto flex items-center gap-1 sm:gap-2 shrink-0">
        <span
          class="text-xs text-ink-faint hidden xl:inline max-w-[180px] truncate"
          >{{ work.statusText }}</span
        >
        <span
          class="text-[11px] sm:text-xs font-medium text-ink-soft px-1.5 sm:px-2 py-1 rounded-lg bg-accent-soft max-w-[5.5rem] sm:max-w-none truncate"
          >@{{ session.session.username }}</span
        >
        <a-button type="text" size="small" class="!px-1.5 sm:!px-2" @click="router.push('/settings')">
          <span class="hidden sm:inline">Settings</span>
          <span class="sm:hidden text-xs">Set</span>
        </a-button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>
