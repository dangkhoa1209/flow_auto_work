<script setup lang="ts">
import { computed } from "vue";
import { useRoute, RouterLink, RouterView } from "vue-router";
import AdminShell from "@/components/layout/AdminShell.vue";
import AppTopbarRight from "@/components/layout/AppTopbarRight.vue";
import MobileBottomNav from "@/components/MobileBottomNav.vue";
import { useSessionStore } from "@/stores/session";
import { settingsDefaultPath } from "@/config/settingsNav";

const route = useRoute();
const session = useSessionStore();

const settingsTo = settingsDefaultPath("admin");
const inSettings = computed(() => route.path.startsWith("/admin/settings"));
</script>

<template>
  <div
    class="faw-app-shell faw-admin-shell h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden bg-[var(--app-bg)]"
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

      <div class="faw-topbar__spacer" />

      <AppTopbarRight :settings-to="settingsTo">
        <template #extra>
          <RouterLink to="/ba" class="faw-btn">ChatBox</RouterLink>
          <RouterLink to="/qc" class="faw-btn">QC</RouterLink>
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
      class="flex-1 min-h-0 pb-[calc(3.25rem+env(safe-area-inset-bottom))] lg:pb-0 overflow-hidden"
    >
      <AdminShell v-if="!inSettings" />
      <RouterView v-else />
    </main>

    <MobileBottomNav />
  </div>
</template>
