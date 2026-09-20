<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Modal } from "ant-design-vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import { useAutoScroll } from "@/composables/useAutoScroll";
import { formatChatTime } from "@/utils/formatChatTime";
import type { BaFailedSend, BaMessage } from "@/stores/baChat";

/** Clickable empty-state tips — prompt fills the composer. */
const EMPTY_TIPS = [
  {
    title: "Annual leave & leave config",
    prompt: "Phép năm tính thế nào khi nhân viên còn thử việc?",
  },
  {
    title: "Attendance data & adjustment reason",
    prompt: "Import chấm công xong, cột Loại và Lý do hiện gì trên danh sách?",
  },
  {
    title: "Staff profile update by column",
    prompt:
      "Import cập nhật thông tin nhân viên theo cột, ô trống thì hệ thống xử lý ra sao?",
  },
] as const;

const props = defineProps<{
  messages: BaMessage[];
  streaming?: boolean;
  streamingMessageId?: string | null;
  /** True while loading messages for a thread switch. */
  loading?: boolean;
  /** Change this when switching project/thread so we pin to latest again. */
  resetKey?: string | null;
  /** Client-only failed Send (before server accepted the user message). */
  failedSend?: BaFailedSend | null;
}>();

const emit = defineEmits<{
  "use-prompt": [prompt: string];
  retry: [];
  regenerate: [messageId: string];
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
    !!props.streaming &&
    !!props.streamingMessageId &&
    m.id === props.streamingMessageId
  );
}

function isErrorMessage(m: BaMessage) {
  return m.role === "assistant" && m.streamStatus === "error";
}

/** Last completed (or errored) assistant bubble — show Regenerate. */
const lastAssistantId = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const m = props.messages[i];
    if (m.role === "assistant" && m.content?.trim()) return m.id;
  }
  return null;
});

function canRegenerate(m: BaMessage) {
  if (props.streaming || props.loading) return false;
  if (m.role !== "assistant") return false;
  if (!m.content?.trim()) return false;
  // Only the latest assistant — regenerating older ones would wipe later turns.
  return m.id === lastAssistantId.value;
}

function requestRegenerate(m: BaMessage) {
  if (!canRegenerate(m)) return;
  const isRetry = isErrorMessage(m);
  Modal.confirm({
    title: isRetry ? "Retry this reply?" : "Regenerate this reply?",
    content: isRetry
      ? "This will try generating the answer again from the previous question."
      : "This will replace the current answer and re-run the previous question.",
    okText: isRetry ? "Retry" : "Regenerate",
    cancelText: "Cancel",
    centered: true,
    onOk: () => {
      emit("regenerate", m.id);
    },
  });
}

const showEmpty = computed(
  () =>
    !props.messages.length &&
    !props.streaming &&
    !props.loading &&
    !props.failedSend,
);

const showSkeleton = computed(
  () => !!props.loading && !props.messages.length && !props.streaming,
);

const listRef = ref<HTMLElement | null>(null);
const { pinnedToBottom, onScroll, onWheel, onTouchMove, resetPin, jumpToBottom } =
  useAutoScroll(listRef, () =>
    [
      visibleMessages.value.map((m) => m.content).join(""),
      showTyping.value ? "t" : "",
      typingInsideStream.value ? "in" : "foot",
      props.failedSend?.content || "",
    ].join("|"),
  );

const showJumpLatest = computed(
  () =>
    !pinnedToBottom.value &&
    (props.messages.length > 0 || !!props.streaming || !!props.failedSend),
);

watch(
  () => props.resetKey,
  (key, prev) => {
    if (key === prev) return;
    resetPin();
    void jumpToBottom();
  },
);

function whoLabel(role: string) {
  if (role === "user") return "You";
  if (role === "system") return "system";
  return "assistant";
}

function onJumpLatest() {
  void jumpToBottom();
}

function onTip(prompt: string) {
  emit("use-prompt", prompt);
}
</script>

<template>
  <div class="faw-ba-msgs relative flex-1 min-h-0 flex flex-col">
    <div
      ref="listRef"
      class="faw-console-scroll flex-1 min-h-0 overflow-y-auto"
      role="log"
      aria-relevant="additions"
      :aria-busy="streaming ? 'true' : undefined"
      :aria-live="streaming ? 'polite' : 'off'"
      @scroll="onScroll"
      @wheel.passive="onWheel"
      @touchmove.passive="onTouchMove"
    >
      <div
        v-if="showSkeleton"
        class="faw-ba-skel space-y-3 py-4"
        aria-busy="true"
        aria-label="Loading messages"
      >
        <div class="faw-ba-skel__row agent">
          <div class="faw-ba-skel__who" />
          <div class="faw-ba-skel__bubble" />
        </div>
        <div class="faw-ba-skel__row user">
          <div class="faw-ba-skel__who" />
          <div class="faw-ba-skel__bubble faw-ba-skel__bubble--short" />
        </div>
        <div class="faw-ba-skel__row agent">
          <div class="faw-ba-skel__who" />
          <div class="faw-ba-skel__bubble" />
        </div>
      </div>

      <div
        v-else-if="showEmpty"
        class="faw-ba-empty flex-1 flex items-center justify-center py-16 px-4"
        role="status"
      >
        <div class="faw-ba-empty__card max-w-md space-y-3">
          <p class="faw-ba-empty__title m-0">
            Ask anything about the selected project
          </p>
          <p class="faw-ba-empty__desc m-0">
            Include a
            <strong class="text-[var(--app-ink)] font-medium">URL</strong>
            or UI anchor (menu, button, screen) so answers match the real system.
          </p>
          <ul class="faw-ba-empty__tips" aria-label="Example prompts">
            <li v-for="tip in EMPTY_TIPS" :key="tip.prompt">
              <button
                type="button"
                class="faw-ba-empty__tip"
                @click="onTip(tip.prompt)"
              >
                <span class="faw-ba-empty__tip-title">{{ tip.title }}</span>
                <span class="faw-ba-empty__tip-prompt">{{ tip.prompt }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>

      <template v-else>
        <div
          v-for="m in visibleMessages"
          :key="m.id"
          class="faw-msg"
          :class="
            m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'agent'
          "
          :data-msg-id="m.id"
        >
          <div class="faw-msg__who">{{ whoLabel(m.role) }}</div>
          <div
            class="faw-msg__bubble"
            :class="{
              'faw-msg__bubble--streaming': isStreamingMessage(m),
              'faw-msg__bubble--error': isErrorMessage(m),
            }"
          >
            <ChatMessageBody
              v-if="m.content"
              :body="m.content"
              :role="m.role === 'user' ? 'user' : 'agent'"
              copyable
            >
              <template #below>
                <span
                  v-if="isStreamingMessage(m)"
                  class="faw-stream-caret"
                  aria-hidden="true"
                />
              </template>
              <template #meta>
                <time
                  v-if="formatChatTime(m.createdAt)"
                  class="faw-msg__time"
                  :datetime="m.createdAt"
                >
                  {{ formatChatTime(m.createdAt) }}
                </time>
                <button
                  v-if="canRegenerate(m)"
                  type="button"
                  class="faw-ba-msg-action"
                  :aria-label="isErrorMessage(m) ? 'Retry reply' : 'Regenerate reply'"
                  @click="requestRegenerate(m)"
                >
                  {{ isErrorMessage(m) ? "Retry" : "Regenerate" }}
                </button>
              </template>
            </ChatMessageBody>
            <template v-else>
              <time
                v-if="formatChatTime(m.createdAt)"
                class="faw-msg__time"
                :datetime="m.createdAt"
              >
                {{ formatChatTime(m.createdAt) }}
              </time>
            </template>
          </div>
        </div>

        <!-- Failed Send before server accepted the user message -->
        <template v-if="failedSend">
          <div class="faw-msg user faw-msg--failed">
            <div class="faw-msg__who">You</div>
            <div class="faw-msg__bubble faw-msg__bubble--failed">
              <div class="chat-md-wrap">
                <div class="chat-md chat-md-user whitespace-pre-wrap">
                  {{ failedSend.content }}
                </div>
                <div class="chat-md-foot">
                  <div class="chat-md-foot__meta">
                    <span class="faw-ba-failed-label">Send failed</span>
                    <button
                      type="button"
                      class="faw-ba-msg-action"
                      aria-label="Retry send"
                      @click="emit('retry')"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="faw-msg agent faw-msg--failed">
            <div class="faw-msg__who">system</div>
            <div class="faw-msg__bubble faw-msg__bubble--error">
              <p class="m-0 text-[12px]">⚠️ {{ failedSend.error }}</p>
            </div>
          </div>
        </template>

        <!-- Only before first token — one assistant row, no duplicate under content -->
        <div v-if="showTypingFooter" class="faw-msg agent">
          <div class="faw-msg__who">assistant</div>
          <div
            class="faw-msg__bubble faw-msg__bubble--typing"
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
        </div>
      </template>
    </div>

    <button
      v-if="showJumpLatest"
      type="button"
      class="faw-ba-jump"
      aria-label="Jump to latest message"
      @click="onJumpLatest"
    >
      Jump to latest
    </button>
  </div>
</template>
