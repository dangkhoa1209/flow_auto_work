<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import { SettingOutlined, ThunderboltOutlined } from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import { useWorkStore } from "@/stores/work";
import { connectRealtime } from "@/realtime/client";

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const work = useWorkStore();

const nav = [
  { to: "/work", label: "Work" },
  { to: "/handoff", label: "Handoff" },
  { to: "/stats", label: "Stats" },
];

const projectLabel = computed(() => {
  const m = session.currentMembership;
  return m?.project.displayName || m?.project.gitlabPath || "—";
});

let disconnectRealtime: (() => void) | undefined;

onMounted(async () => {
  try {
    await work.refreshAll();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
  // Listen channel — no more /api/status + /api/jobs every 1.5s
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
</script>

<template>
  <div class="h-full max-h-full flex flex-col overflow-hidden">
    <header
      class="shrink-0 border-b border-line bg-surface-raised/85 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 shadow-sm"
    >
      <div class="flex items-center gap-2.5 min-w-0">
        <div
          class="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-accent-bright to-sky-500 text-white shadow-sm"
        >
          <ThunderboltOutlined class="text-sm" />
        </div>
        <div class="min-w-0">
          <div class="font-semibold tracking-tight brand-mark leading-tight">
            Flow Auto Work
          </div>
          <div class="text-xs text-ink-faint truncate hidden sm:block">
            {{ projectLabel }}
          </div>
        </div>
      </div>

      <nav class="flex items-center gap-1 ml-2 p-1 rounded-xl bg-surface-muted/80">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="px-3 py-1.5 rounded-lg text-sm text-ink-muted hover:text-ink hover:bg-surface-raised transition"
          :class="
            route.path.startsWith(item.to)
              ? '!text-accent !bg-surface-raised font-semibold shadow-sm'
              : ''
          "
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="ml-auto flex items-center gap-2">
        <span
          class="text-xs text-ink-faint hidden md:inline max-w-[220px] truncate"
          >{{ work.statusText }}</span
        >
        <span
          class="text-xs font-medium text-ink-soft px-2 py-1 rounded-lg bg-accent-soft"
          >@{{ session.session.username }}</span
        >
        <a-button type="text" @click="router.push('/settings')">
          <template #icon><SettingOutlined /></template>
          Settings
        </a-button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>
