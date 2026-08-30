<script setup lang="ts">
import { inject } from "vue";
import { Modal, message } from "ant-design-vue";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons-vue";
import { useBaChatStore } from "@/stores/baChat";

const ba = useBaChatStore();
const closeSide = inject<() => void>("baCloseSide", () => undefined);

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
    title: "Xóa chat?",
    content: title,
    okType: "danger",
    okText: "Xóa",
    cancelText: "Hủy",
    onOk: async () => {
      try {
        await ba.deleteThread(id);
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
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
            ? 'Chọn project ở thanh trên cùng'
            : !ba.projectReady
              ? 'Project chưa sẵn sàng — liên hệ admin'
              : 'Bắt đầu hội thoại mới'
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
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto">
      <div
        v-if="!ba.threads.length"
        class="px-3 py-10 text-center text-[11px] text-[var(--app-faint)]"
      >
        Chưa có chat.<br />Bấm <b class="text-[var(--app-muted)]">New Chat</b> để bắt đầu.
      </div>
      <button
        v-for="t in ba.threads"
        :key="t.id"
        type="button"
        class="faw-ba-thread"
        :class="{ active: t.id === ba.activeThreadId }"
        @click="onSelectThread(t.id)"
      >
        <div class="faw-ba-thread__main">
          <span class="faw-ba-thread__title">{{ t.title }}</span>
          <span class="faw-ba-thread__time">{{ formatTime(t.updatedAt) }}</span>
        </div>
        <button
          type="button"
          class="faw-icon-btn faw-ba-thread__del"
          title="Xóa"
          @click.stop="onDelete(t.id, t.title)"
        >
          <DeleteOutlined />
        </button>
      </button>
    </div>
  </aside>
</template>
