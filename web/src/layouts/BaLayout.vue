<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import { useSessionStore } from "@/stores/session";
import { useBaChatStore } from "@/stores/baChat";
import { connectRealtime } from "@/realtime/client";

const router = useRouter();
const session = useSessionStore();
const ba = useBaChatStore();

let disconnect: (() => void) | undefined;

const statusDot = computed(() => (ba.streaming ? "wip" : "idle"));
const statusText = computed(() =>
  ba.streaming
    ? "Đang trả lời…"
    : ba.selectedProject
      ? ba.selectedProject.displayName
      : "Chọn project",
);

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
  // Clear BA chat before navigating away (avoid leaking admin threads to next user)
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
    class="h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden overflow-x-hidden bg-[var(--app-bg)]"
  >
    <header class="faw-topbar">
      <div class="faw-brand" title="Project Chat">
        <img
          class="faw-brand__logo"
          src="/logo.svg"
          alt="Flow Auto WorkBench"
          width="148"
          height="33"
          draggable="false"
        />
      </div>

      <div class="faw-seg hidden sm:flex">
        <span class="faw-seg__btn active">Project Chat</span>
      </div>

      <div class="faw-topbar__spacer" />

      <div class="faw-topbar__right">
        <span class="faw-idle">
          <span class="faw-idle__dot" :class="statusDot" />
          {{ statusText }}
        </span>
        <div class="faw-user-chip">
          <span class="faw-avatar" />
          @{{ session.session.username }}
        </div>
        <RouterLink
          v-if="session.isAdmin"
          to="/admin"
          class="faw-btn"
          title="Admin"
        >
          Admin
        </RouterLink>
        <button type="button" class="faw-btn" title="Logout" @click="logout">
          Logout
        </button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>
