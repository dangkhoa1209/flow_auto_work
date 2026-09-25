<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute, RouterLink, RouterView } from "vue-router";
import AdminShell from "@/components/layout/AdminShell.vue";
import BrandLogo from "@/components/layout/BrandLogo.vue";
import AppTopbarRight from "@/components/layout/AppTopbarRight.vue";
import MobileBottomNav from "@/components/MobileBottomNav.vue";
import { useSessionStore } from "@/stores/session";
import { settingsDefaultPath } from "@/config/settingsNav";
import { consumePostLoginGreeting } from "@/utils/postLoginGreeting";

const route = useRoute();
const session = useSessionStore();

const settingsTo = settingsDefaultPath("admin");
const inSettings = computed(() => route.path.startsWith("/admin/settings"));

onMounted(() => {
  // Dashboard hero already greets — clear flag so it does not linger for later shells.
  consumePostLoginGreeting();
});
</script>

<template>
  <div
    class="faw-app-shell faw-admin-shell h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden bg-[var(--app-bg)]"
  >
    <header class="faw-topbar faw-topbar--admin">
      <RouterLink to="/admin" class="faw-brand" title="Admin">
        <BrandLogo
          class="faw-brand__logo faw-brand__logo--full"
          variant="compact"
          width="132"
          height="30"
        />
        <BrandLogo
          class="faw-brand__logo faw-brand__logo--mark"
          variant="mark"
          width="28"
          height="28"
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
