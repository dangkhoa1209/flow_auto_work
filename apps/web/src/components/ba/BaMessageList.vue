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
  /** Change this when switching project/thread so we pin to latest again. */
  resetKey?: string | null;
}>();

/**
 * AgentConsole-style typing: stay until the turn finishes (`streaming`
 * goes false). Prefer nesting under the streaming reply so there is only
 * one assistant row (content + thinking), not a second bubble.
 * Always "thinking…" — no per-step progress labels in the bubble.
 */
const showTyping = computed(() => !!props.streaming);

const typingHint = "thinking…";

const streamingMessage = computed(() => {
  const id = props.streamingMessageId;
  if (!id) return null;
  return props.messages.find((m) => m.id === id) || null;
});

/** Attach thinking under the reply when it already has tokens. */
const typingInsideStream = computed(
  () =>
    showTyping.value &&
    !!streamingMessage.value?.content?.trim(),
);

/** Standalone typing row only while waiting for the first token. */
const showTypingFooter = computed(
  () => showTyping.value && !typingInsideStream.value,
);

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

function isStreamingMessage(m: BaMessage) {
  return (
    typingInsideStream.value &&
    !!props.streamingMessageId &&
    m.id === props.streamingMessageId
  );
}

const listRef = ref<HTMLElement | null>(null);
const { onScroll, onWheel, onTouchMove, resetPin, scrollToBottom } =
  useAutoScroll(listRef, () =>
    [
      visibleMessages.value.map((m) => m.content).join(""),
      showTyping.value ? "t" : "",
      typingInsideStream.value ? "in" : "foot",
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
      class="faw-ba-empty flex-1 flex items-center justify-center py-16 px-4"
      role="status"
    >
      <div class="faw-ba-empty__card max-w-md text-center space-y-3">
        <p class="faw-ba-empty__title m-0">
          Ask anything about the selected project
        </p>
        <p class="faw-ba-empty__desc m-0">
          Include a
          <strong class="text-[var(--app-ink)] font-medium">URL</strong>
          or UI anchor (menu, button, screen) so answers match the real system.
        </p>
        <ul class="faw-ba-empty__tips" aria-label="Example prompts">
          <li>How does the attendance rules screen validate shifts?</li>
          <li>Summarize this page: https://…</li>
          <li>Draft an issue for the bug I described</li>
        </ul>
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
          <template #below>
            <div
              v-if="isStreamingMessage(m)"
              class="faw-msg__typing-inline"
              aria-live="polite"
              aria-label="Thinking"
            >
              <span class="chat-typing">
                <span /><span /><span />
              </span>
              <span class="text-[11px] text-[var(--app-faint)] ml-1.5">{{
                typingHint
              }}</span>
            </div>
          </template>
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

    <!-- Only before first token — one assistant row, no duplicate under content -->
    <div v-if="showTypingFooter" class="faw-msg agent">
      <div class="faw-msg__who">assistant</div>
      <div class="faw-msg__bubble faw-msg__bubble--typing" aria-live="polite">
        <span class="chat-typing" aria-label="Thinking">
          <span /><span /><span />
        </span>
        <span class="text-[11px] text-[var(--app-faint)] ml-1.5">{{
          typingHint
        }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.faw-msg__typing-inline {
  display: inline-flex;
  align-items: center;
  margin-top: 8px;
}
</style>
