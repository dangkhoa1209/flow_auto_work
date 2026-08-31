<script setup lang="ts">
import { computed } from "vue";
import { useRoute, RouterLink, RouterView } from "vue-router";
import AppTopbarRight from "@/components/layout/AppTopbarRight.vue";
import { useSessionStore } from "@/stores/session";

const route = useRoute();
const session = useSessionStore();

const tabs = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/chatbox", label: "Project Chatbox" },
  { to: "/admin/ai-engine", label: "AI Engine" },
  { to: "/admin/task-types", label: "Task labels" },
  { to: "/admin/ba-features", label: "BA features" },
];

const inSettings = computed(() => route.path.startsWith("/admin/settings"));

function isTabActive(tab: (typeof tabs)[0]): boolean {
  if (tab.to === "/admin/users") {
    return route.path === "/admin" || route.path.startsWith("/admin/users");
  }
  return route.path === tab.to || route.path.startsWith(`${tab.to}/`);
}
</script>

<template>
  <div
    class="faw-app-shell h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden bg-[var(--app-bg)]"
  >
    <header class="faw-topbar faw-topbar--admin">
      <RouterLink to="/admin/users" class="faw-brand" title="Admin">
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

      <nav v-if="!inSettings" class="faw-seg hidden lg:flex">
        <RouterLink
          v-for="t in tabs"
          :key="t.to"
          :to="t.to"
          class="faw-seg__btn"
          :class="{ active: isTabActive(t) }"
        >
          {{ t.label }}
        </RouterLink>
      </nav>

      <div class="faw-topbar__spacer" />

      <AppTopbarRight settings-to="/admin/settings/account" class="hidden lg:contents">
        <template #extra>
          <RouterLink to="/ba" class="faw-btn">BA Chat</RouterLink>
          <RouterLink
            v-if="session.canAccessDevops"
            to="/devops"
            class="faw-btn"
          >
            Build
          </RouterLink>
        </template>
      </AppTopbarRight>
    </header>

    <main
      class="flex-1 min-h-0"
      :class="inSettings ? 'overflow-hidden' : 'overflow-y-auto'"
    >
      <RouterView />
    </main>
  </div>
</template>
