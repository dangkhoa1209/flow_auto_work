<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import {
  DownOutlined,
  PlusOutlined,
  CheckOutlined,
} from "@ant-design/icons-vue";
import AppTopbarRight from "@/components/layout/AppTopbarRight.vue";
import AppSwitcher from "@/components/layout/AppSwitcher.vue";
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

const nav = computed(() => [
  { to: "/work", label: "Work" },
  { to: "/handoff", label: "Handoff" },
  { to: "/stats", label: "Stats" },
]);

const switching = ref(false);
const selectedProjectId = ref(session.session.projectId || "");
const projectPickerOpen = ref(false);

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

const projectSheetHeight = computed(() => {
  if (typeof window === "undefined") return 480;
  return Math.min(520, Math.round(window.innerHeight * 0.72));
});

let disconnectRealtime: (() => void) | undefined;

function bindRealtime() {
  disconnectRealtime?.();
  disconnectRealtime = connectRealtime({
    onOpen: () => {
      void work.resyncRealtime();
    },
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
}

onMounted(async () => {
  selectedProjectId.value = session.session.projectId || "";
  try {
    await work.refreshAll();
    await settings.loadHandoffPrefs(session.projectId);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
  bindRealtime();
});

onUnmounted(() => {
  disconnectRealtime?.();
});

async function onSwitchProject(projectId: string) {
  if (!projectId) return;
  if (projectId === session.session.projectId) {
    projectPickerOpen.value = false;
    return;
  }
  switching.value = true;
  try {
    work.clearOpenSelection();
    await session.activateProject(projectId);
    selectedProjectId.value = projectId;
    projectPickerOpen.value = false;
    // SSE URL embeds project id — reconnect so events aren't filtered for the old project
    bindRealtime();
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
  projectPickerOpen.value = false;
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
  <div
    class="faw-app-shell h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden overflow-x-hidden bg-[var(--app-bg)]"
  >
    <header class="faw-topbar faw-topbar--work">
      <!-- Brand: full logo desktop, icon-only mobile -->
      <RouterLink to="/work" class="faw-brand" title="Flow Auto WorkBench">
        <img
          class="faw-brand__logo faw-brand__logo--full"
          src="/logo.svg"
          alt="Flow Auto WorkBench"
          width="148"
          height="33"
          draggable="false"
        />
        <img
          class="faw-brand__logo faw-brand__logo--mark"
          src="/favicon.svg"
          alt="FLOW.AUTO"
          width="28"
          height="28"
          draggable="false"
        />
      </RouterLink>

      <AppSwitcher />

      <!-- Desktop: inline project select -->
      <div class="faw-crumb hidden lg:flex">
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

      <!-- Mobile: tappable truncated workspace → bottom sheet -->
      <button
        type="button"
        class="faw-crumb-tap lg:hidden"
        :disabled="switching || !projectOptions.length"
        :title="activeProject?.label || 'Select project'"
        @click="projectPickerOpen = true"
      >
        <span class="faw-crumb-tap__flow">{{
          activeProject?.flowName || "Select project"
        }}</span>
        <span class="faw-crumb-tap__path">{{
          activeProject?.gitlabPath || ""
        }}</span>
        <DownOutlined class="faw-crumb-tap__chev" />
      </button>

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

      <div class="faw-topbar__spacer hidden lg:block" />

      <AppTopbarRight settings-to="/settings/project">
        <template #status>
          <span class="faw-idle">
            <span class="faw-idle__dot" :class="idleDot" />
            {{ work.statusText || "Idle" }}
          </span>
        </template>
        <template #extra>
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
        </template>
      </AppTopbarRight>
    </header>

    <nav class="faw-mseg lg:hidden" aria-label="Workbench sections">
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="faw-mseg__btn"
        :class="{ active: route.path.startsWith(item.to) }"
      >
        {{ item.label }}
      </RouterLink>
    </nav>

    <main
      class="flex-1 min-h-0 overflow-hidden overflow-x-hidden pb-[calc(3.25rem+env(safe-area-inset-bottom))] lg:pb-0"
    >
      <RouterView />
    </main>

    <MobileBottomNav />

    <!-- Mobile project picker (bottom sheet) -->
    <a-drawer
      v-model:open="projectPickerOpen"
      placement="bottom"
      :height="projectSheetHeight"
      :title="null"
      :closable="false"
      class="faw-project-sheet"
      root-class-name="faw-project-sheet-root"
      :body-style="{ padding: 0 }"
    >
      <div class="faw-project-sheet__head">
        <div>
          <p class="faw-project-sheet__eyebrow">Workspace</p>
          <h3 class="faw-project-sheet__title">Chọn project</h3>
        </div>
        <button
          type="button"
          class="faw-btn"
          @click="goManageProjects"
        >
          <PlusOutlined /> Manage
        </button>
      </div>
      <div class="faw-project-sheet__list">
        <button
          v-for="o in projectOptions"
          :key="o.value"
          type="button"
          class="faw-project-sheet__item touch-manipulation"
          :class="{
            'is-active': o.value === (selectedProjectId || session.session.projectId),
          }"
          :disabled="switching"
          @click="onSwitchProject(o.value)"
        >
          <div class="min-w-0 flex-1">
            <div class="faw-project-sheet__name truncate">{{ o.flowName }}</div>
            <div class="faw-project-sheet__repo truncate font-mono">
              {{ o.gitlabPath }}
            </div>
          </div>
          <CheckOutlined
            v-if="o.value === (selectedProjectId || session.session.projectId)"
            class="faw-project-sheet__check"
          />
        </button>
        <p
          v-if="!projectOptions.length"
          class="px-4 py-8 text-center text-ink-faint text-sm"
        >
          Chưa có project — thêm trong Settings.
        </p>
      </div>
    </a-drawer>
  </div>
</template>
