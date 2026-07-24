<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import {
  ProjectOutlined,
  PlusOutlined,
} from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import { useWorkStore } from "@/stores/work";
import { connectRealtime } from "@/realtime/client";
import MobileBottomNav from "@/components/MobileBottomNav.vue";

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
  <div class="h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden overflow-x-hidden">
    <!-- Compact top bar: logo + project (nav tabs → bottom on mobile) -->
    <header
      class="shrink-0 border-b border-line bg-surface-raised/95 backdrop-blur-md px-2.5 sm:px-4 py-2 sm:py-2.5 flex items-center gap-2 sm:gap-3 shadow-sm"
    >
      <RouterLink
        to="/work"
        class="flex items-center gap-2 min-w-0 shrink-0 hover:opacity-90 transition-opacity"
        title="Flow Auto WorkBench"
      >
        <img
          src="/logo.svg"
          alt="Flow Auto WorkBench"
          class="h-6 sm:h-8 w-auto max-w-[min(120px,32vw)] lg:max-w-[min(200px,42vw)] object-contain object-left"
          width="200"
          height="50"
        />
      </RouterLink>

      <div
        class="flex items-center gap-1 sm:gap-1.5 min-w-0 flex-1 max-w-none sm:max-w-md lg:max-w-lg"
      >
        <ProjectOutlined class="text-ink-faint shrink-0 hidden sm:inline" />
        <a-select
          v-model:value="selectedProjectId"
          class="w-full min-w-0 project-select"
          placeholder="GitLab > Flow project"
          :loading="switching"
          :disabled="switching || !projectOptions.length"
          show-search
          option-filter-prop="label"
          option-label-prop="label"
          @change="(v: string) => onSwitchProject(v)"
        >
          <a-select-option
            v-for="o in projectOptions"
            :key="o.value"
            :value="o.value"
            :label="o.label"
          >
            <div class="flex flex-col gap-0.5 min-w-0 py-0.5 leading-tight">
              <span
                class="text-[11px] font-mono text-ink-faint truncate"
                :title="o.gitlabPath"
                >{{ o.gitlabPath }}</span
              >
              <span class="text-sm text-ink truncate" :title="o.flowName">{{
                o.flowName
              }}</span>
            </div>
          </a-select-option>
        </a-select>
        <a-tooltip title="Tạo project">
          <a-button
            type="text"
            size="small"
            class="shrink-0"
            @click="goManageProjects"
          >
            <template #icon><PlusOutlined /></template>
          </a-button>
        </a-tooltip>
      </div>

      <!-- Desktop top nav -->
      <nav
        class="hidden lg:flex items-center gap-1 p-1 rounded-xl bg-surface-muted/80 shrink-0"
      >
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="px-3 py-1.5 rounded-lg text-sm text-ink-muted hover:text-ink hover:bg-surface-raised transition whitespace-nowrap"
          :class="
            route.path.startsWith(item.to)
              ? '!text-accent !bg-surface-raised font-semibold shadow-sm'
              : ''
          "
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="ml-auto hidden lg:flex items-center gap-2 shrink-0">
        <span
          class="text-xs text-ink-faint hidden xl:inline max-w-[180px] truncate"
          >{{ work.statusText }}</span
        >
        <span
          class="text-xs font-medium text-ink-soft px-2 py-1 rounded-lg bg-accent-soft truncate"
          >@{{ session.session.username }}</span
        >
        <a-button type="text" size="small" @click="router.push('/settings')">
          Settings
        </a-button>
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
