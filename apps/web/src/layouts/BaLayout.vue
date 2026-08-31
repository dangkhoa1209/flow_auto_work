<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRouter, RouterLink, RouterView, useRoute } from "vue-router";
import { message } from "ant-design-vue";
import { MenuOutlined } from "@ant-design/icons-vue";
import AppTopbarRight from "@/components/layout/AppTopbarRight.vue";
import AppSwitcher from "@/components/layout/AppSwitcher.vue";
import { useSessionStore } from "@/stores/session";
import { useBaChatStore } from "@/stores/baChat";
import { connectRealtime } from "@/realtime/client";
import BaProjectSelect from "@/components/ba/BaProjectSelect.vue";
import BaGitPatModal from "@/components/ba/BaGitPatModal.vue";
import MobileBottomNav from "@/components/MobileBottomNav.vue";

const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const ba = useBaChatStore();
const sideOpen = ref(false);

let disconnect: (() => void) | undefined;

const statusDot = computed(() => (ba.streaming ? "wip" : "idle"));
const statusText = computed(() =>
  ba.streaming
    ? ba.currentProgressLabel || "Đang trả lời…"
    : ba.selectedProject
      ? ba.selectedProject.displayName
      : "Chọn project",
);

const navActive = computed(() => {
  if (route.path.startsWith("/ba/settings")) return "settings";
  if (route.name === "ba-workflow") return "workflow";
  if (route.name === "ba-tasks") return "tasks";
  return "chat";
});

const showProjectSelect = computed(() => navActive.value !== "settings");

const showWorkflowTab = computed(() => ba.featureVisible("workflow"));
const showTasksTab = computed(() => ba.featureVisible("tasks"));
const workflowTabLabel = computed(() =>
  ba.featureLabel("workflow", ba.features.workflowTabLabel || "Phân tích YC"),
);
const tasksTabLabel = computed(() => ba.featureLabel("tasks", "Tasks"));

watch(
  () => [ba.featuresLoaded, route.name] as const,
  ([loaded, name]) => {
    if (!loaded) return;
    if (
      (name === "ba-workflow" && !showWorkflowTab.value) ||
      (name === "ba-tasks" && !showTasksTab.value)
    ) {
      void router.replace({ name: "ba-chat" });
    }
  },
  { immediate: true },
);

function closeSide() {
  sideOpen.value = false;
}

function toggleSide() {
  sideOpen.value = !sideOpen.value;
}

provide("baCloseSide", closeSide);

onMounted(async () => {
  try {
    await ba.bootstrap();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
  disconnect = connectRealtime({
    onBaMessage: (ev) => ba.applyBaMessage(ev),
    onBaDelta: (ev) => ba.applyBaDelta(ev),
    onBaDone: (ev) => ba.applyBaDone(ev),
    onBaError: (ev) => ba.applyBaError(ev),
    onBaProgress: (ev) => ba.applyBaProgress(ev),
    onBaIssueDraftProgress: (ev) => ba.applyBaIssueDraftProgress(ev),
    onBaIssueDraftDone: (ev) => ba.applyBaIssueDraftDone(ev),
    onBaIssueDraftError: (ev) => ba.applyBaIssueDraftError(ev),
  });
});

onUnmounted(() => {
  disconnect?.();
});
</script>

<template>
  <div
    class="faw-app-shell faw-ba-shell h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden overflow-x-hidden bg-[var(--app-bg)]"
    :class="{ 'is-side-open': sideOpen }"
  >
    <header class="faw-topbar faw-topbar--ba">
      <button
        type="button"
        class="faw-icon-btn faw-ba-menu-btn lg:hidden"
        title="Chats"
        @click="toggleSide"
      >
        <MenuOutlined />
      </button>

      <RouterLink to="/ba" class="faw-brand" title="Project Chat">
        <img
          class="faw-brand__logo faw-brand__logo--full"
          src="/logo.svg"
          alt="FLOW.AUTO"
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

      <nav v-if="navActive !== 'settings'" class="faw-seg hidden lg:flex">
        <RouterLink
          to="/ba"
          class="faw-seg__btn"
          :class="{ active: navActive === 'chat' }"
        >
          Chat
        </RouterLink>
        <RouterLink
          v-if="showWorkflowTab"
          to="/ba/workflow"
          class="faw-seg__btn"
          :class="{ active: navActive === 'workflow' }"
        >
          {{ workflowTabLabel }}
        </RouterLink>
        <RouterLink
          v-if="showTasksTab"
          to="/ba/tasks"
          class="faw-seg__btn"
          :class="{ active: navActive === 'tasks' }"
        >
          {{ tasksTabLabel }}
        </RouterLink>
      </nav>

      <div
        v-if="showProjectSelect"
        class="faw-crumb hidden lg:flex faw-ba-topbar-project"
        title="Project — dùng chung cho Chat / Phân tích YC / Tasks"
      >
        <BaProjectSelect :show-label="false" size="small" />
      </div>

      <div class="faw-topbar__spacer" />

      <AppTopbarRight settings-to="/ba/settings/gitlab" class="hidden lg:contents">
        <template #status>
          <span class="faw-idle faw-ba-idle">
            <span class="faw-idle__dot" :class="statusDot" />
            <span class="faw-ba-idle__text">{{ statusText }}</span>
          </span>
        </template>
        <template #extra>
          <RouterLink v-if="session.isAdmin" to="/admin/users" class="faw-btn">
            Admin
          </RouterLink>
        </template>
      </AppTopbarRight>
    </header>

    <main
      class="flex-1 min-h-0 overflow-hidden flex flex-col pb-[calc(3.25rem+env(safe-area-inset-bottom))] lg:pb-0"
    >
      <div class="flex-1 min-h-0 overflow-hidden">
        <RouterView />
      </div>
    </main>

    <MobileBottomNav />

    <button
      v-if="sideOpen"
      type="button"
      class="faw-ba-backdrop lg:hidden"
      aria-label="Close sidebar"
      @click="closeSide"
    />
  </div>

  <BaGitPatModal />
</template>
