<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from "vue";
import { useRouter, RouterLink, RouterView, useRoute } from "vue-router";
import { message } from "ant-design-vue";
import { MenuOutlined } from "@ant-design/icons-vue";
import BrandLogo from "@/components/layout/BrandLogo.vue";
import AppTopbarRight from "@/components/layout/AppTopbarRight.vue";
import AppSwitcher from "@/components/layout/AppSwitcher.vue";
import PostLoginGreeting from "@/components/layout/PostLoginGreeting.vue";
import { useSessionStore } from "@/stores/session";
import { useBaChatStore } from "@/stores/baChat";
import { useProjectChatBase } from "@/composables/useProjectChatBase";
import BaProjectSelect from "@/components/ba/BaProjectSelect.vue";
import BaGitPatModal from "@/components/ba/BaGitPatModal.vue";
import BaSyncDbControl from "@/components/ba/BaSyncDbControl.vue";
import MobileBottomNav from "@/components/MobileBottomNav.vue";
import { settingsDefaultPath } from "@/config/settingsNav";

const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const ba = useBaChatStore();
const { basePath, routeName } = useProjectChatBase();
const sideOpen = ref(false);

const settingsTo = computed(() => settingsDefaultPath(basePath.value));

const statusDot = computed(() => (ba.streaming ? "wip" : "idle"));
const statusText = computed(() =>
  ba.streaming
    ? "thinking…"
    : ba.selectedProject
      ? ba.selectedProject.displayName
      : "Select project",
);

const navActive = computed(() => {
  if (route.path.startsWith(`${basePath.value}/settings`)) return "settings";
  if (route.name === routeName("workflow")) return "workflow";
  if (route.name === routeName("tasks")) return "tasks";
  if (route.name === routeName("create-data")) return "create-data";
  return "chat";
});

const showProjectSelect = computed(() => navActive.value !== "settings");

const showWorkflowTab = computed(() => ba.featureVisible("workflow"));
const showTasksTab = computed(() => ba.featureVisible("tasks"));
const showCreateDataTab = computed(() => ba.featureVisible("createData"));
const chatTabLabel = "Chatbox";
const workflowTabLabel = computed(() =>
  ba.featureLabel("workflow", ba.features.workflowTabLabel || "Requirements"),
);
const tasksTabLabel = computed(() => ba.featureLabel("tasks", "Tasks"));
const createDataTabLabel = computed(() =>
  ba.featureLabel("createData", "Create Data"),
);

watch(
  () => [ba.featuresLoaded, route.name, basePath.value] as const,
  ([loaded, name]) => {
    if (!loaded) return;
    if (
      (name === routeName("workflow") && !showWorkflowTab.value) ||
      (name === routeName("tasks") && !showTasksTab.value) ||
      (name === routeName("create-data") && !showCreateDataTab.value)
    ) {
      void router.replace({ name: routeName("chat") });
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

onMounted(() => {
  // Remount after Work↔BA: keep bootstrap off the critical path when store is warm.
  void (async () => {
    try {
      await ba.bootstrap();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  })();
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
        aria-label="Open chats"
        :aria-expanded="sideOpen"
        aria-controls="faw-ba-thread-drawer"
        @click="toggleSide"
      >
        <MenuOutlined />
      </button>

      <RouterLink :to="basePath" class="faw-brand" title="Project Chat">
        <BrandLogo
          class="faw-brand__logo faw-brand__logo--full"
          width="148"
          height="33"
        />
        <BrandLogo
          class="faw-brand__logo faw-brand__logo--mark"
          variant="mark"
          width="28"
          height="28"
        />
      </RouterLink>

      <AppSwitcher />

      <nav v-if="navActive !== 'settings'" class="faw-seg hidden lg:flex">
        <RouterLink
          :to="basePath"
          class="faw-seg__btn"
          :class="{ active: navActive === 'chat' }"
        >
          {{ chatTabLabel }}
        </RouterLink>
        <RouterLink
          v-if="showWorkflowTab"
          :to="`${basePath}/workflow`"
          class="faw-seg__btn"
          :class="{ active: navActive === 'workflow' }"
        >
          {{ workflowTabLabel }}
        </RouterLink>
        <RouterLink
          v-if="showTasksTab"
          :to="`${basePath}/tasks`"
          class="faw-seg__btn"
          :class="{ active: navActive === 'tasks' }"
        >
          {{ tasksTabLabel }}
        </RouterLink>
        <RouterLink
          v-if="showCreateDataTab"
          :to="`${basePath}/create-data`"
          class="faw-seg__btn"
          :class="{ active: navActive === 'create-data' }"
        >
          {{ createDataTabLabel }}
        </RouterLink>
      </nav>

      <!-- Project in topbar (mobile + desktop) — one picker only -->
      <div
        v-if="showProjectSelect"
        class="faw-crumb faw-ba-topbar-project min-w-0 flex-1 lg:flex-none lg:min-w-[180px] max-w-[320px]"
        title="Project — shared for Chat / Workflow / Tasks / Create Data"
      >
        <BaProjectSelect :show-label="false" embedded size="small" />
      </div>

      <div class="faw-topbar__spacer hidden lg:block" />

      <!-- One instance: mobile CSS already hides desktop chrome + settings -->
      <AppTopbarRight :settings-to="settingsTo">
        <template #status>
          <span class="faw-idle faw-ba-idle">
            <span class="faw-idle__dot" :class="statusDot" />
            <span class="faw-ba-idle__text">{{ statusText }}</span>
          </span>
        </template>
        <template #extra>
          <BaSyncDbControl />
          <RouterLink v-if="session.isAdmin" to="/admin" class="faw-btn">
            Admin
          </RouterLink>
        </template>
      </AppTopbarRight>
    </header>

    <PostLoginGreeting />

    <nav
      v-if="navActive !== 'settings'"
      class="faw-mseg lg:hidden"
      aria-label="Project chat sections"
    >
      <RouterLink
        :to="basePath"
        class="faw-mseg__btn"
        :class="{ active: navActive === 'chat' }"
      >
        {{ chatTabLabel }}
      </RouterLink>
      <RouterLink
        v-if="showWorkflowTab"
        :to="`${basePath}/workflow`"
        class="faw-mseg__btn"
        :class="{ active: navActive === 'workflow' }"
      >
        {{ workflowTabLabel }}
      </RouterLink>
      <RouterLink
        v-if="showTasksTab"
        :to="`${basePath}/tasks`"
        class="faw-mseg__btn"
        :class="{ active: navActive === 'tasks' }"
      >
        {{ tasksTabLabel }}
      </RouterLink>
      <RouterLink
        v-if="showCreateDataTab"
        :to="`${basePath}/create-data`"
        class="faw-mseg__btn"
        :class="{ active: navActive === 'create-data' }"
      >
        {{ createDataTabLabel }}
      </RouterLink>
    </nav>

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
