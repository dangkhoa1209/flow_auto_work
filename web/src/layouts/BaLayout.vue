<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import { useSessionStore } from "@/stores/session";
import { useBaChatStore } from "@/stores/baChat";
import { connectRealtime } from "@/realtime/client";

const router = useRouter();
const session = useSessionStore();
const ba = useBaChatStore();

let disconnect: (() => void) | undefined;

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
  });
});

onUnmounted(() => {
  disconnect?.();
});

async function logout() {
  await session.logout();
  message.success("Signed out");
  await router.push({ name: "login" });
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-col bg-surface">
    <header
      class="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-line bg-surface-raised"
    >
      <img src="/logo.svg" alt="" class="h-7 w-auto" draggable="false" />
      <span class="text-sm font-semibold text-ink">Project Chat</span>
      <span class="text-xs text-ink-muted truncate">
        {{ session.me?.gitlabUsername }}
      </span>
      <div class="flex-1" />
      <RouterLink
        v-if="session.isAdmin"
        to="/admin"
        class="text-sm text-accent hover:underline"
      >
        Admin
      </RouterLink>
      <button
        type="button"
        class="text-sm text-ink-muted hover:text-ink"
        @click="logout"
      >
        Logout
      </button>
    </header>
    <main class="flex-1 min-h-0">
      <RouterView />
    </main>
  </div>
</template>
