<script setup lang="ts">
import { computed } from "vue";
import { useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import { useSessionStore } from "@/stores/session";
import { useThemeStore } from "@/stores/theme";

const router = useRouter();
const session = useSessionStore();
const themeStore = useThemeStore();

const statusText = computed(() =>
  session.me?.gitlabUsername ? `@${session.me.gitlabUsername}` : "Devops",
);

async function logout() {
  await session.logout();
  message.success("Signed out");
  await router.push({ name: "login" });
}
</script>

<template>
  <div
    class="h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden bg-[var(--app-bg)]"
  >
    <header
      class="shrink-0 flex items-center gap-4 px-4 py-3 border-b border-line bg-surface-raised"
    >
      <RouterLink to="/devops" class="flex items-center gap-2 min-w-0">
        <img src="/logo.svg" alt="" class="h-7 w-auto" draggable="false" />
        <span class="text-sm font-semibold text-ink truncate">Devops</span>
      </RouterLink>
      <nav class="flex gap-1 flex-1">
        <RouterLink
          to="/devops"
          class="px-3 py-1.5 rounded-md text-sm font-semibold text-accent bg-accent-soft"
        >
          Builds
        </RouterLink>
        <RouterLink
          v-if="session.isAdmin"
          to="/admin"
          class="px-3 py-1.5 rounded-md text-sm text-ink-muted hover:text-ink hover:bg-surface transition"
        >
          Admin
        </RouterLink>
        <RouterLink
          v-if="session.me?.roles?.includes('dev')"
          to="/work"
          class="px-3 py-1.5 rounded-md text-sm text-ink-muted hover:text-ink hover:bg-surface transition"
        >
          Work
        </RouterLink>
      </nav>
      <div class="flex items-center gap-3 text-sm text-ink-muted">
        <button
          type="button"
          class="px-2 py-1 rounded-md hover:text-ink hover:bg-surface transition"
          :title="
            themeStore.mode === 'dark'
              ? 'Switch to light mode'
              : 'Switch to dark mode'
          "
          @click="themeStore.toggle()"
        >
          {{ themeStore.mode === "dark" ? "☀" : "☾" }}
        </button>
        <span class="truncate max-w-[10rem]">{{ statusText }}</span>
        <button
          type="button"
          class="text-accent hover:underline font-medium"
          @click="logout"
        >
          Logout
        </button>
      </div>
    </header>
    <main class="flex-1 min-h-0 overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>
