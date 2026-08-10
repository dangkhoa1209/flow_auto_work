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
    title: "Delete chat?",
    content: title,
    okType: "danger",
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
  <aside
    class="h-full min-h-0 w-64 shrink-0 flex flex-col border-r border-line bg-surface-raised"
  >
    <div class="p-3 border-b border-line space-y-2">
      <label class="block text-xs font-medium text-ink-muted">Project</label>
      <a-select
        :value="ba.selectedProjectId || undefined"
        :options="projectOptions"
        placeholder="Select project"
        class="w-full"
        :disabled="!ba.projects.length"
        @update:value="(v: string) => onProjectChange(v)"
      />
      <a-tooltip
        :title="
          !ba.selectedProjectId
            ? 'Chọn project trước'
            : !ba.projectReady
              ? 'Project chưa sẵn sàng — liên hệ admin'
              : 'Start a new conversation'
        "
      >
        <button
          type="button"
          class="faw-btn faw-btn--run w-full flex items-center justify-center gap-1"
          :disabled="!ba.projectReady || ba.streaming"
          @click="onNewChat"
        >
          <PlusOutlined /> New Chat
        </button>
      </a-tooltip>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto p-2">
      <div
        v-if="!ba.threads.length"
        class="text-xs text-ink-muted text-center py-8 px-2"
      >
        Chưa có chat. Bấm New Chat để bắt đầu.
      </div>
      <ul class="list-none m-0 p-0 space-y-0.5">
        <li v-for="t in ba.threads" :key="t.id">
          <div
            class="group flex items-center gap-1 rounded-md px-2 py-2 cursor-pointer text-sm"
            :class="
              t.id === ba.activeThreadId
                ? 'bg-accent-soft text-accent font-medium'
                : 'text-ink hover:bg-surface'
            "
            @click="ba.selectThread(t.id)"
          >
            <span class="flex-1 min-w-0 truncate">{{ t.title }}</span>
            <button
              type="button"
              class="opacity-0 group-hover:opacity-100 p-1 text-ink-muted hover:text-red-600"
              title="Delete"
              @click.stop="onDelete(t.id, t.title)"
            >
              <DeleteOutlined />
            </button>
          </div>
        </li>
      </ul>
    </div>
  </aside>
</template>
