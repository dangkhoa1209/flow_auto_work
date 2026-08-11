<script setup lang="ts">
import { computed } from "vue";
import { Modal, message } from "ant-design-vue";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons-vue";
import { useBaChatStore } from "@/stores/baChat";

const ba = useBaChatStore();

const projectOptions = computed(() =>
  ba.projects.map((p) => ({
    value: p.id,
    label: p.ready
      ? p.displayName
      : `${p.displayName} (${p.cloneStatus})`,
    disabled: !p.ready,
  })),
);

async function onProjectChange(id: string) {
  try {
    await ba.selectProject(id);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onNewChat() {
  try {
    await ba.newChat();
  } catch (e) {
    message.warning(e instanceof Error ? e.message : String(e));
  }
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

    <div class="faw-filters">
      <label class="block text-[10px] font-semibold uppercase tracking-wide text-[var(--app-faint)]">
        Project
      </label>
      <a-select
        :value="ba.selectedProjectId || undefined"
        :options="projectOptions"
        placeholder="Select project"
        class="w-full faw-ba-select"
        size="small"
        :disabled="!ba.projects.length"
        show-search
        option-filter-prop="label"
        @update:value="onProjectChange"
      />
      <a-tooltip
        :title="
          !ba.selectedProjectId
            ? 'Chọn project trước'
            : !ba.projectReady
              ? 'Project chưa sẵn sàng — liên hệ admin'
              : 'Bắt đầu hội thoại mới'
        "
      >
        <button
          type="button"
          class="faw-btn faw-btn--run w-full flex items-center justify-center gap-1.5"
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
        @click="ba.selectThread(t.id)"
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
