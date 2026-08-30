<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRouter, RouterLink, RouterView, useRoute } from "vue-router";
import { message } from "ant-design-vue";
import { MenuOutlined } from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import { useBaChatStore } from "@/stores/baChat";
import { useThemeStore } from "@/stores/theme";
import { connectRealtime } from "@/realtime/client";
import BaProjectSelect from "@/components/ba/BaProjectSelect.vue";
import BaGitPatModal from "@/components/ba/BaGitPatModal.vue";

const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const ba = useBaChatStore();
const themeStore = useThemeStore();
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
  if (route.name === "ba-workflow") return "workflow";
  if (route.name === "ba-tasks") return "tasks";
  if (route.name === "ba-settings") return "settings";
  return "chat";
});

/** Project chọn ở header — dùng chung cho Chat / Phân tích YC / Tasks. */
const showProjectSelect = computed(() => navActive.value !== "settings");

/** Tabs theo feature flag: hide ẩn hẳn, lab hiện kèm nhãn "(lab)". */
const showWorkflowTab = computed(() => ba.featureVisible("workflow"));
const showTasksTab = computed(() => ba.featureVisible("tasks"));
const workflowTabLabel = computed(() =>
  ba.featureLabel("workflow", ba.features.workflowTabLabel || "Phân tích YC"),
);
const tasksTabLabel = computed(() => ba.featureLabel("tasks", "Tasks"));

// Route đang đứng bị admin ẩn → quay về Chat
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

async function logout() {
  try {
    const { useBaChatStore } = await import("@/stores/baChat");
    useBaChatStore().reset();
  } catch {
    /* ignore */
  }
  await session.logout();
  message.success("Signed out");
  await router.push({ name: "login" });
}
</script>

<template>
  <div
    class="faw-ba-shell h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden overflow-x-hidden bg-[var(--app-bg)]"
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

      <div class="faw-seg hidden sm:flex">
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
      </div>

      <div
        v-if="showProjectSelect"
        class="faw-ba-topbar-project min-w-0 w-40 sm:w-52"
        title="Project — dùng chung cho Chat / Phân tích YC / Tasks"
      >
        <BaProjectSelect :show-label="false" size="small" />
      </div>

      <div class="faw-topbar__spacer" />

      <div class="faw-topbar__right faw-ba-top-right">
        <span class="faw-idle faw-ba-idle">
          <span class="faw-idle__dot" :class="statusDot" />
          <span class="faw-ba-idle__text">{{ statusText }}</span>
        </span>
        <div class="faw-user-chip faw-ba-user">
          <span class="faw-avatar" />
          <span class="faw-ba-user__name">@{{ session.session.username }}</span>
        </div>
        <button
          type="button"
          class="faw-icon-btn"
          :title="
            themeStore.mode === 'dark'
              ? 'Chuyển giao diện sáng'
              : 'Chuyển giao diện tối'
          "
          @click="themeStore.toggle()"
        >
          {{ themeStore.mode === "dark" ? "☀" : "☾" }}
        </button>
        <RouterLink
          v-if="session.isAdmin"
          to="/admin"
          class="faw-btn"
          title="Admin"
        >
          Admin
        </RouterLink>
        <RouterLink
          to="/ba/settings"
          class="faw-btn"
          :class="{ 'faw-btn--run': navActive === 'settings' }"
          title="Settings"
        >
          Settings
        </RouterLink>
        <button type="button" class="faw-btn" title="Logout" @click="logout">
          Logout
        </button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-hidden flex flex-col">
      <div class="flex-1 min-h-0 overflow-hidden">
        <RouterView />
      </div>
    </main>

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
