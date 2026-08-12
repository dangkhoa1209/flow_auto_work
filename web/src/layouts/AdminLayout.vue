<script setup lang="ts">
import { useRoute, useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import { useSessionStore } from "@/stores/session";
import { useThemeStore } from "@/stores/theme";

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const themeStore = useThemeStore();

const tabs = [
  { to: "/admin", label: "Projects", exact: true },
  { to: "/admin/cursor", label: "Cursor key" },
];

async function logout() {
  await session.logout();
  message.success("Signed out");
  await router.push({ name: "login" });
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-col bg-surface">
    <header
      class="shrink-0 flex items-center gap-4 px-4 py-3 border-b border-line bg-surface-raised"
    >
      <div class="flex items-center gap-2 min-w-0">
        <img src="/logo.svg" alt="" class="h-7 w-auto" draggable="false" />
        <span class="text-sm font-semibold text-ink truncate">Admin</span>
      </div>
      <nav class="flex gap-1 flex-1">
        <RouterLink
          v-for="t in tabs"
          :key="t.to"
          :to="t.to"
          class="px-3 py-1.5 rounded-md text-sm text-ink-muted hover:text-ink hover:bg-surface transition"
          :class="
            (t.exact ? route.path === t.to : route.path.startsWith(t.to))
              ? '!text-accent font-semibold bg-accent-soft'
              : ''
          "
        >
          {{ t.label }}
        </RouterLink>
        <RouterLink
          to="/ba"
          class="px-3 py-1.5 rounded-md text-sm text-ink-muted hover:text-ink hover:bg-surface transition"
        >
          BA Chat
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
        <span class="truncate max-w-[10rem]">{{ session.me?.gitlabUsername }}</span>
        <button
          type="button"
          class="text-accent hover:underline font-medium"
          @click="logout"
        >
          Logout
        </button>
      </div>
    </header>
    <main class="flex-1 min-h-0 overflow-y-auto">
      <RouterView />
    </main>
  </div>
</template>
