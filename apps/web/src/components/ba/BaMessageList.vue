<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import { useAutoScroll } from "@/composables/useAutoScroll";
import { formatChatTime } from "@/utils/formatChatTime";
import type { BaMessage } from "@/stores/baChat";

const props = defineProps<{
  messages: BaMessage[];
  streaming?: boolean;
  streamingMessageId?: string | null;
  progressHint?: string;
  /** Change this when switching project/thread so we pin to latest again. */
  resetKey?: string | null;
}>();

/**
 * AgentConsole-style typing: stay under the streaming reply until the
 * turn finishes (`streaming` goes false), not only before the first token.
 */
const showTypingFooter = computed(() => !!props.streaming);

const typingHint = computed(() => props.progressHint || "thinking…");

/** Avoid a blank assistant row while the footer typing bubble is shown. */
const visibleMessages = computed(() =>
  props.messages.filter((m) => {
    if (m.content) return true;
    if (m.role !== "assistant") return true;
    if (
      showTypingFooter.value &&
      props.streamingMessageId &&
      m.id === props.streamingMessageId
    ) {
      return false;
    }
    return true;
  }),
);

const listRef = ref<HTMLElement | null>(null);
const { onScroll, onWheel, onTouchMove, resetPin, scrollToBottom } =
  useAutoScroll(listRef, () =>
    [
      visibleMessages.value.map((m) => m.content).join(""),
      showTypingFooter.value ? "t" : "",
      typingHint.value,
    ].join("|"),
  );

watch(
  () => props.resetKey,
  (key, prev) => {
    if (key === prev) return;
    resetPin();
    void scrollToBottom(true);
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
    @wheel.passive="onWheel"
    @touchmove.passive="onTouchMove"
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
      v-for="m in visibleMessages"
      :key="m.id"
      class="faw-msg"
      :class="
        m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'agent'
      "
    >
      <div class="faw-msg__who">{{ whoLabel(m.role) }}</div>
      <div class="faw-msg__bubble">
        <ChatMessageBody
          v-if="m.content"
          :body="m.content"
          :role="m.role === 'user' ? 'user' : 'agent'"
          copyable
        >
          <template #meta>
            <time
              v-if="formatChatTime(m.createdAt)"
              class="faw-msg__time"
              :datetime="m.createdAt"
            >
              {{ formatChatTime(m.createdAt) }}
            </time>
          </template>
        </ChatMessageBody>
        <time
          v-else-if="formatChatTime(m.createdAt)"
          class="faw-msg__time"
          :datetime="m.createdAt"
        >
          {{ formatChatTime(m.createdAt) }}
        </time>
      </div>
    </div>

    <!-- Mirror AgentConsole: typing under the reply until the turn ends -->
    <div v-if="showTypingFooter" class="faw-msg agent">
      <div class="faw-msg__who">assistant</div>
      <div class="faw-msg__bubble faw-msg__bubble--typing">
        <span class="chat-typing" aria-label="Đang suy nghĩ">
          <span /><span /><span />
        </span>
        <span class="text-[11px] text-[var(--app-faint)] ml-1.5">{{
          typingHint
        }}</span>
      </div>
    </div>
  </div>
</template>
