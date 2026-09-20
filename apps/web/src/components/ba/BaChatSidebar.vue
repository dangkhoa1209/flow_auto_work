<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { Modal, message } from "ant-design-vue";
import { PlusOutlined, DeleteOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { useBaChatStore } from "@/stores/baChat";
import { formatRelativeTime } from "@/utils/formatChatTime";

const ba = useBaChatStore();
const closeSide = inject<() => void>("baCloseSide", () => undefined);

const threadQuery = ref("");

const showSearch = computed(() => ba.threads.length >= 8);

const filteredThreads = computed(() => {
  const q = threadQuery.value.trim().toLowerCase();
  if (!q) return ba.threads;
  return ba.threads.filter((t) => t.title.toLowerCase().includes(q));
});

/** Last message snippet for the active thread (others load on select). */
const activeSnippet = computed(() => {
  const msgs = ba.messages;
  if (!msgs.length) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i]?.content?.trim();
    if (c) {
      const oneLine = c.replace(/\s+/g, " ");
      return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
    }
  }
  return "";
});

async function onNewChat() {
  try {
    await ba.newChat();
    closeSide();
  } catch (e) {
    message.warning(e instanceof Error ? e.message : String(e));
  }
}

function onSelectThread(id: string) {
  ba.selectThread(id);
  closeSide();
}

function onDelete(id: string, title: string) {
  Modal.confirm({
    title: "Delete this chat?",
    content: title,
    okType: "danger",
    okText: "Delete",
    cancelText: "Cancel",
    onOk: async () => {
      try {
        await ba.deleteThread(id);
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      }
    },
  });
}
</script>

<template>
  <aside class="faw-col faw-ba-side flex flex-col min-h-0 overflow-hidden h-full">
    <div class="faw-col-head">
      <h2>Chats</h2>
      <span class="faw-count">{{ ba.threads.length }}</span>
    </div>

    <div class="faw-filters faw-ba-filters">
      <a-tooltip
        :title="
          !ba.selectedProjectId
            ? 'Select a project in the top bar'
            : !ba.projectReady
              ? 'Project is not ready yet — ask an admin'
              : 'Start a new conversation'
        "
      >
        <button
          type="button"
          class="faw-btn faw-btn--run faw-ba-new"
          :disabled="!ba.projectReady || ba.streaming"
          @click="onNewChat"
        >
          <PlusOutlined /> New Chat
        </button>
      </a-tooltip>
      <div v-if="showSearch" class="faw-ba-thread-search">
        <SearchOutlined class="faw-ba-thread-search__icon" aria-hidden="true" />
        <input
          v-model="threadQuery"
          type="search"
          class="faw-ba-thread-search__input"
          placeholder="Filter chats…"
          aria-label="Filter chats"
        />
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto">
      <div
        v-if="!ba.threads.length"
        class="px-3 py-10 text-center text-[11px] text-[var(--app-faint)]"
      >
        No chats yet.<br />Click
        <b class="text-[var(--app-muted)]">New Chat</b> to start.
      </div>
      <div
        v-else-if="!filteredThreads.length"
        class="px-3 py-8 text-center text-[11px] text-[var(--app-faint)]"
      >
        No chats match “{{ threadQuery.trim() }}”
      </div>
      <div
        v-for="t in filteredThreads"
        :key="t.id"
        role="button"
        tabindex="0"
        class="faw-ba-thread"
        :class="{ active: t.id === ba.activeThreadId }"
        @click="onSelectThread(t.id)"
        @keydown.enter.prevent="onSelectThread(t.id)"
      >
        <div class="faw-ba-thread__main">
          <span class="faw-ba-thread__title">{{ t.title }}</span>
          <span
            v-if="t.id === ba.activeThreadId && activeSnippet"
            class="faw-ba-thread__snip"
            >{{ activeSnippet }}</span
          >
          <span class="faw-ba-thread__time">{{
            formatRelativeTime(t.updatedAt)
          }}</span>
        </div>
        <button
          type="button"
          class="faw-icon-btn faw-ba-thread__del"
          title="Delete"
          aria-label="Delete chat"
          @click.stop="onDelete(t.id, t.title)"
        >
          <DeleteOutlined />
        </button>
      </div>
    </div>
  </aside>
</template>
