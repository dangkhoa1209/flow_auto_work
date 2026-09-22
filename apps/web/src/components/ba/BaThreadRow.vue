<script setup lang="ts">
import {
  DeleteOutlined,
  PushpinOutlined,
  PushpinFilled,
  EditOutlined,
} from "@ant-design/icons-vue";
import { formatRelativeTime } from "@/utils/formatChatTime";
import type { BaThread } from "@/stores/baChat";

defineProps<{
  thread: BaThread;
  active?: boolean;
  snippet?: string;
  renaming?: boolean;
  renameDraft: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  "start-rename": [thread: BaThread, e?: Event];
  "commit-rename": [];
  "cancel-rename": [];
  "update:renameDraft": [value: string];
  "set-rename-el": [el: HTMLInputElement | null];
  "toggle-pin": [thread: BaThread, e: Event];
  delete: [id: string, title: string];
}>();
</script>

<template>
  <div
    role="button"
    tabindex="0"
    class="faw-ba-thread"
    :class="{
      active,
      'faw-ba-thread--pinned': thread.pinned,
    }"
    @click="emit('select', thread.id)"
    @keydown.enter.prevent="emit('select', thread.id)"
    @dblclick.stop="emit('start-rename', thread)"
  >
    <div class="faw-ba-thread__main">
      <template v-if="renaming">
        <input
          :ref="
            (el) =>
              emit(
                'set-rename-el',
                (el as HTMLInputElement | null) || null,
              )
          "
          :value="renameDraft"
          type="text"
          class="faw-ba-thread__rename"
          maxlength="120"
          aria-label="Rename chat"
          @click.stop
          @input="
            emit(
              'update:renameDraft',
              ($event.target as HTMLInputElement).value,
            )
          "
          @keydown.enter.prevent="emit('commit-rename')"
          @keydown.esc.prevent="emit('cancel-rename')"
          @blur="emit('commit-rename')"
        />
      </template>
      <template v-else>
        <div class="faw-ba-thread__top">
          <span class="faw-ba-thread__title">
            <PushpinFilled
              v-if="thread.pinned"
              class="faw-ba-thread__pin-mark"
              aria-hidden="true"
            />
            {{ thread.title }}
          </span>
          <span class="faw-ba-thread__time">{{
            formatRelativeTime(thread.updatedAt)
          }}</span>
        </div>
        <span v-if="active && snippet" class="faw-ba-thread__snip">{{
          snippet
        }}</span>
      </template>
    </div>
    <div
      v-if="!renaming"
      class="faw-ba-thread__actions"
      @click.stop
    >
      <button
        type="button"
        class="faw-icon-btn"
        :title="thread.pinned ? 'Unpin' : 'Pin'"
        :aria-label="thread.pinned ? 'Unpin chat' : 'Pin chat'"
        @click="emit('toggle-pin', thread, $event)"
      >
        <PushpinFilled v-if="thread.pinned" />
        <PushpinOutlined v-else />
      </button>
      <button
        type="button"
        class="faw-icon-btn"
        title="Rename"
        aria-label="Rename chat"
        @click="emit('start-rename', thread, $event)"
      >
        <EditOutlined />
      </button>
      <button
        type="button"
        class="faw-icon-btn faw-ba-thread__del"
        title="Delete"
        aria-label="Delete chat"
        @click="emit('delete', thread.id, thread.title)"
      >
        <DeleteOutlined />
      </button>
    </div>
  </div>
</template>
