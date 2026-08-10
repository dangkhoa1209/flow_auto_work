<script setup lang="ts">
import { ref, watch } from "vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import { useAutoScroll } from "@/composables/useAutoScroll";
import type { BaMessage } from "@/stores/baChat";

const props = defineProps<{
  messages: BaMessage[];
  streaming?: boolean;
  streamingMessageId?: string | null;
}>();

const listRef = ref<HTMLElement | null>(null);
const { onScroll } = useAutoScroll(listRef, () =>
  props.messages.map((m) => m.content).join(""),
);

watch(
  () => props.streaming,
  () => {
    /* keep auto-scroll source reactive via content watch */
  },
);
</script>

<template>
  <div
    ref="listRef"
    class="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3"
    @scroll="onScroll"
  >
    <div
      v-if="!messages.length"
      class="h-full flex items-center justify-center text-ink-muted text-sm text-center px-6"
    >
      Hỏi bất cứ điều gì về dự án đã chọn — agent sẽ đọc source và trả lời.
    </div>
    <div
      v-for="m in messages"
      :key="m.id"
      class="flex"
      :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
    >
      <div
        class="max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm"
        :class="
          m.role === 'user'
            ? 'bg-accent text-white'
            : 'bg-surface-raised border border-line text-ink'
        "
      >
        <ChatMessageBody
          v-if="m.content"
          :body="m.content"
          :role="m.role === 'user' ? 'user' : 'agent'"
        />
        <span
          v-else-if="streaming && streamingMessageId === m.id"
          class="text-ink-muted italic"
        >
          đang suy nghĩ…
        </span>
      </div>
    </div>
  </div>
</template>
