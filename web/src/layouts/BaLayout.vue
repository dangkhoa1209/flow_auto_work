<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref } from "vue";
import { useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import { MenuOutlined } from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import { useBaChatStore } from "@/stores/baChat";
import { connectRealtime } from "@/realtime/client";

const router = useRouter();
const session = useSessionStore();
const ba = useBaChatStore();
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
        <span class="faw-seg__btn active">Project Chat</span>
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

    <button
      v-if="sideOpen"
      type="button"
      class="faw-ba-backdrop lg:hidden"
      aria-label="Close sidebar"
      @click="closeSide"
    />
  </div>
</template>
