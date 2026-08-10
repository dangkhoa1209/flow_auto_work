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
    /* content watch drives auto-scroll */
  },
);

function whoLabel(role: string) {
  if (role === "user") return "You";
  if (role === "system") return "system";
  return "assistant";
}
</script>

<template>
  <div
    ref="listRef"
    class="faw-console-scroll flex-1 min-h-0 overflow-y-auto"
    @scroll="onScroll"
  >
    <div
      v-if="!messages.length && !streaming"
      class="flex-1 flex items-center justify-center py-16 px-4"
    >
      <div class="max-w-sm text-center space-y-2">
        <p class="text-[13px] font-semibold text-[var(--app-ink)] m-0">
          Hỏi bất cứ điều gì về dự án đã chọn
        </p>
        <p class="text-[11.5px] text-[var(--app-muted)] m-0 leading-relaxed">
          Nên kèm
          <strong class="text-[var(--app-ink)] font-medium">URL</strong>
          hoặc điểm neo trên UI (menu, nút, màn hình) để trả lời khớp hệ thống.
        </p>
      </div>
    </div>

    <div
      v-for="m in messages"
      :key="m.id"
      class="faw-msg"
      :class="
        m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'agent'
      "
    >
      <div class="faw-msg__who">{{ whoLabel(m.role) }}</div>
      <div
        class="faw-msg__bubble"
        :class="{
          'faw-msg__bubble--typing':
            !m.content && streaming && streamingMessageId === m.id,
        }"
      >
        <ChatMessageBody
          v-if="m.content"
          :body="m.content"
          :role="m.role === 'user' ? 'user' : 'agent'"
        />
        <template v-else-if="streaming && streamingMessageId === m.id">
          <span class="chat-typing" aria-label="Đang suy nghĩ">
            <span /><span /><span />
          </span>
          <span class="text-[11px] text-[var(--app-faint)] ml-1.5"
            >đang suy nghĩ…</span
          >
        </template>
      </div>
    </div>
  </div>
</template>
