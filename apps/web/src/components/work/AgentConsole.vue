<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { DownOutlined, ExclamationCircleOutlined } from "@ant-design/icons-vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import RepoTerminal from "@/components/work/RepoTerminal.vue";
import { useAutoScroll } from "@/composables/useAutoScroll";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { formatChatTime } from "@/utils/formatChatTime";
import type { Job } from "@/stores/work";

const PROGRESS_OPEN_KEY = "flow.console.progressOpen";
const PROGRESS_H_KEY = "flow.console.progressHeight";
const PROGRESS_H_MIN = 120;
const PROGRESS_H_DEFAULT = 240;
/** Keep chat messages usable when Process is expanded. */
const CHAT_RESERVE_MIN = 200;
const HEADER_FALLBACK = 48;

const props = withDefaults(
  defineProps<{
    jobLoading: boolean;
    currentJob: Job | null;
    chat: Array<{ role: string; body: string; createdAt?: string }>;
    agentTyping: boolean;
    progressLines: Array<{
      id: number;
      at: string;
      kind: string;
      text: string;
    }>;
    progressLive: boolean;
    chatInput: string;
    busy: boolean;
    sendBusy: boolean;
    stopBusy: boolean;
    canForceStop: boolean;
    canResetWindow: boolean;
    agentWindowShort: string | null;
    contextQuality: Job["contextQuality"] | null;
    /** Agent = code; Plan = Cursor plan mode only */
    planFirst?: boolean;
    /** Mobile: Chat | Logs tabs instead of split panes */
    mobileTabs?: boolean;
    failedSend?: { content: string; error: string; mode: "continue" | "ask" } | null;
  }>(),
  { mobileTabs: false, planFirst: false, failedSend: null },
);

const emit = defineEmits<{
  "update:chatInput": [string];
  "update:planFirst": [boolean];
  sendChat: ["continue" | "ask"];
  forceStop: [];
  resetWindow: [];
  retryFailedSend: [];
}>();

const agentRunMode = computed(() => (props.planFirst ? "plan" : "agent"));

function onAgentRunMode(v: string) {
  emit("update:planFirst", v === "plan");
}

/** Enter / ⌘·Ctrl+Enter → Send; Shift+Enter → newline; Esc → Force Stop. */
function onChatKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (props.canForceStop && !props.stopBusy) {
      e.preventDefault();
      e.stopPropagation();
      emit("forceStop");
    }
    return;
  }
  if (e.key !== "Enter") return;
  if (e.isComposing) return;
  if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  if (!props.chatInput.trim() || props.stopBusy || props.sendBusy) return;
  emit("sendChat", "continue");
}

const rootEl = ref<HTMLElement | null>(null);
const headerEl = ref<HTMLElement | null>(null);
const chatBox = ref<HTMLElement | null>(null);
const progressBox = ref<HTMLElement | null>(null);
const mobileConsoleTab = ref<"chat" | "logs" | "terminal">("chat");
/** Desktop bottom panel: Process logs vs Terminal */
const bottomTab = ref<"logs" | "terminal">("logs");
const terminalEnabled = ref(false);
const progressOpen = ref(false);
const progressHeight = ref(PROGRESS_H_DEFAULT);
const progressMaxPx = ref(PROGRESS_H_DEFAULT);
const progressDragging = ref(false);

let dragStartY = 0;
let dragStartH = 0;
let dragMoved = false;
let dragPointerId: number | null = null;
let rootResizeObserver: ResizeObserver | null = null;
let chatResizeObserver: ResizeObserver | null = null;

async function loadTerminalStatus() {
  try {
    const res = await api<{ enabled?: boolean }>(API.terminal.status);
    terminalEnabled.value = Boolean(res?.enabled);
  } catch {
    terminalEnabled.value = false;
  }
}

onMounted(() => {
  try {
    const raw = localStorage.getItem(PROGRESS_OPEN_KEY);
    if (raw === "1" || raw === "true") progressOpen.value = true;
    const h = Number(localStorage.getItem(PROGRESS_H_KEY));
    if (Number.isFinite(h) && h >= PROGRESS_H_MIN) {
      progressHeight.value = Math.round(h);
    }
  } catch {
    /* ignore */
  }
  void loadTerminalStatus();
  void nextTick(() => {
    reclampProgressHeight();
    if (rootEl.value && typeof ResizeObserver !== "undefined") {
      rootResizeObserver = new ResizeObserver(() => {
        reclampProgressHeight();
      });
      rootResizeObserver.observe(rootEl.value);
    }
  });
});

watch(progressOpen, (open) => {
  try {
    localStorage.setItem(PROGRESS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (open) void nextTick(() => reclampProgressHeight());
});

function persistProgressHeight() {
  try {
    localStorage.setItem(PROGRESS_H_KEY, String(progressHeight.value));
  } catch {
    /* ignore */
  }
}

function maxProgressHeight() {
  const rootH = rootEl.value?.clientHeight ?? 640;
  const headerH = headerEl.value?.offsetHeight ?? HEADER_FALLBACK;
  const available = rootH - headerH - CHAT_RESERVE_MIN;
  return Math.max(PROGRESS_H_MIN, Math.floor(available));
}

function clampProgressHeight(h: number) {
  return Math.min(maxProgressHeight(), Math.max(PROGRESS_H_MIN, Math.round(h)));
}

function reclampProgressHeight() {
  progressMaxPx.value = maxProgressHeight();
  if (props.mobileTabs || !progressOpen.value) return;
  const next = clampProgressHeight(progressHeight.value);
  if (next !== progressHeight.value) {
    progressHeight.value = next;
    persistProgressHeight();
  }
}

function openProcessPanel() {
  progressOpen.value = true;
  bottomTab.value = "logs";
  if (props.mobileTabs) mobileConsoleTab.value = "logs";
}

function openTerminalPanel() {
  progressOpen.value = true;
  bottomTab.value = "terminal";
  if (props.mobileTabs) mobileConsoleTab.value = "terminal";
}

function closeProgressPanel() {
  progressOpen.value = false;
}

/** Process / Terminal tabs — switch only (never toggle-close). */
function onBottomTabPointerDown(e: PointerEvent, tab: "logs" | "terminal") {
  e.preventDefault();
  e.stopPropagation();
  if (tab === "logs") openProcessPanel();
  else openTerminalPanel();
}

function onProgressRailPointerDown(e: PointerEvent) {
  if (props.mobileTabs || e.button !== 0) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest?.(".console-progress__label--tab")) return;

  if (!progressOpen.value) {
    // Collapsed + click empty rail → open Process
    openProcessPanel();
    return;
  }

  // Open: drag to resize; click (no drag) → close
  dragStartY = e.clientY;
  dragStartH = progressHeight.value;
  dragMoved = false;
  dragPointerId = e.pointerId;
  progressDragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", onProgressRailPointerMove);
  window.addEventListener("pointerup", onProgressRailPointerUp);
  window.addEventListener("pointercancel", onProgressRailPointerUp);
}

function onProgressRailPointerMove(e: PointerEvent) {
  if (!progressDragging.value) return;
  const dy = dragStartY - e.clientY;
  if (Math.abs(dy) > 4) dragMoved = true;
  progressMaxPx.value = maxProgressHeight();
  progressHeight.value = clampProgressHeight(dragStartH + dy);
}

function onProgressRailPointerUp(e: PointerEvent) {
  if (dragPointerId != null && e.pointerId !== dragPointerId) return;
  window.removeEventListener("pointermove", onProgressRailPointerMove);
  window.removeEventListener("pointerup", onProgressRailPointerUp);
  window.removeEventListener("pointercancel", onProgressRailPointerUp);
  progressDragging.value = false;
  dragPointerId = null;
  if (!dragMoved) {
    closeProgressPanel();
  } else {
    persistProgressHeight();
  }
}

onUnmounted(() => {
  window.removeEventListener("pointermove", onProgressRailPointerMove);
  window.removeEventListener("pointerup", onProgressRailPointerUp);
  window.removeEventListener("pointercancel", onProgressRailPointerUp);
  rootResizeObserver?.disconnect();
  rootResizeObserver = null;
  chatResizeObserver?.disconnect();
  chatResizeObserver = null;
});

const chatScroll = useAutoScroll(chatBox, () => [
  props.chat.length,
  props.chat.at(-1)?.body,
  props.agentTyping,
  props.failedSend?.content,
]);
const lastProgress = () => props.progressLines.at(-1);
const progressScroll = useAutoScroll(progressBox, () => [
  props.progressLines.length,
  lastProgress()?.id,
  lastProgress()?.text,
]);

const progressErrorsOnly = ref(false);

const PROGRESS_ERR_RE = /\b(error|failed|fail|warn|exception|fatal)\b/i;

const visibleProgressLines = computed(() => {
  if (!progressErrorsOnly.value) return props.progressLines;
  return props.progressLines.filter(
    (l) =>
      l.kind === "error" ||
      l.kind === "err" ||
      l.kind === "warn" ||
      PROGRESS_ERR_RE.test(l.text),
  );
});

const showJumpChat = computed(
  () =>
    !chatScroll.pinnedToBottom.value &&
    (props.chat.length > 0 || props.agentTyping || !!props.failedSend),
);

const showJumpProgress = computed(
  () =>
    !progressScroll.pinnedToBottom.value &&
    (visibleProgressLines.value.length > 0 || props.progressLive),
);

async function copyVisibleProgress() {
  const text = visibleProgressLines.value
    .map((l) => l.text)
    .join("\n")
    .trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

function jumpPinnedPanes(force: boolean) {
  void nextTick().then(() => {
    requestAnimationFrame(() => {
      void chatScroll.scrollToBottom(force);
      void progressScroll.scrollToBottom(force);
    });
  });
}

watch(
  () => [props.jobLoading, props.currentJob?.id] as const,
  ([loading, id], prev) => {
    if (id !== prev?.[1]) {
      chatScroll.resetPin();
      progressScroll.resetPin();
    }
    if (loading) return;
    jumpPinnedPanes(true);
  },
  { immediate: true },
);

watch(mobileConsoleTab, (tab) => {
  if (tab === "chat") void chatScroll.scrollToBottom();
  if (tab === "logs") void progressScroll.scrollToBottom();
});

watch(progressOpen, (open) => {
  if (open) void progressScroll.scrollToBottom();
});

watch(bottomTab, (tab) => {
  if (tab === "logs") void progressScroll.scrollToBottom();
});

// chatBox is inside v-if="!jobLoading" — follow pin when the pane remounts / uncollapses
watch(chatBox, (el, prev) => {
  if (prev && chatResizeObserver) {
    chatResizeObserver.disconnect();
    chatResizeObserver = null;
  }
  if (!el || typeof ResizeObserver === "undefined") return;
  let lastH = el.clientHeight;
  chatResizeObserver = new ResizeObserver(() => {
    const box = chatBox.value;
    if (!box) return;
    const h = box.clientHeight;
    if (lastH === 0 && h > 0) void chatScroll.scrollToBottom();
    lastH = h;
  });
  chatResizeObserver.observe(el);
  if (el.clientHeight > 0) void chatScroll.scrollToBottom();
});
</script>

<template>
  <aside
    ref="rootEl"
    class="flex flex-col min-h-0 overflow-hidden relative h-full faw-console"
    :class="{
      'select-none': progressDragging,
      'faw-console--mobile': mobileTabs,
    }"
  >
    <div
      v-if="jobLoading"
      class="absolute inset-0 z-20 bg-surface p-3 space-y-2"
      aria-busy="true"
    >
      <div class="skel h-4 w-32" />
      <div class="skel h-12 w-full" />
      <div class="skel h-8 w-[90%]" />
      <div class="skel h-8 w-[80%]" />
      <div class="skel h-8 w-[70%]" />
      <div class="skel h-24 w-full mt-2" />
      <div class="skel h-7 w-full mt-auto" />
    </div>

    <template v-if="!jobLoading">
      <!-- Header / toolbar — mockup console-head (slim on mobile tabs) -->
      <div ref="headerEl" class="faw-console-head">
        <div v-if="!mobileTabs" class="faw-console-head__title">
          <h2>Agent console</h2>
          <div
            v-if="agentWindowShort"
            class="faw-console-head__win"
            :title="currentJob?.agentId || ''"
          >
            window {{ agentWindowShort }}
          </div>
          <div v-else class="faw-console-head__win">No window linked</div>
        </div>
        <div v-else class="faw-console-head__title faw-console-head__title--mobile">
          <div
            v-if="agentWindowShort"
            class="faw-console-head__win"
            :title="currentJob?.agentId || ''"
          >
            {{ agentWindowShort }}
          </div>
          <div v-else class="faw-console-head__win">No window</div>
        </div>
        <div class="faw-console-actions">
          <template v-if="terminalEnabled && !mobileTabs">
            <button
              type="button"
              class="faw-btn"
              :class="{
                'faw-btn--run':
                  progressOpen && bottomTab === 'logs',
              }"
              title="View Process / agent progress"
              @click="openProcessPanel"
            >
              Process
              <span
                v-if="progressLive"
                class="console-progress__live inline-block ml-1 align-middle"
                aria-label="live"
              />
            </button>
            <button
              type="button"
              class="faw-btn"
              :class="{
                'faw-btn--run':
                  progressOpen && bottomTab === 'terminal',
              }"
              title="Terminal trong repo project"
              @click="openTerminalPanel"
            >
              Terminal
            </button>
          </template>
          <a-popconfirm
            v-if="canForceStop"
            title="Force Stop agent?"
            ok-text="Stop"
            cancel-text="Cancel"
            ok-type="danger"
            @confirm="emit('forceStop')"
          >
            <button type="button" class="faw-btn" :disabled="stopBusy">
              Stop
            </button>
          </a-popconfirm>
          <a-popconfirm
            v-if="canResetWindow"
            title="Reset agent window?"
            ok-text="Reset"
            cancel-text="Cancel"
            ok-type="danger"
            @confirm="emit('resetWindow')"
          >
            <template #description>
              Stop the run if active and unlink the old Cursor window. Chat
              history is preserved.
            </template>
            <button type="button" class="faw-btn" :disabled="busy || !currentJob">
              ⟲ Reset
            </button>
          </a-popconfirm>
        </div>
      </div>

      <!-- Mobile: Chat | Logs | Terminal switcher -->
      <div
        v-if="mobileTabs"
        class="faw-m-console-tabs shrink-0"
        role="tablist"
        aria-label="Console panels"
      >
        <button
          type="button"
          role="tab"
          class="faw-m-console-tabs__btn touch-manipulation fx-colors"
          :class="{
            'is-active': mobileConsoleTab === 'chat',
            'is-live': mobileConsoleTab !== 'chat' && (agentTyping || busy),
          }"
          :aria-selected="mobileConsoleTab === 'chat'"
          @click="mobileConsoleTab = 'chat'"
        >
          Chat
          <span
            v-if="mobileConsoleTab !== 'chat' && (agentTyping || busy)"
            class="faw-m-seg__live"
            aria-label="Agent typing"
          />
        </button>
        <button
          type="button"
          role="tab"
          class="faw-m-console-tabs__btn touch-manipulation fx-colors"
          :class="{
            'is-active': mobileConsoleTab === 'logs',
            'is-live': mobileConsoleTab !== 'logs' && progressLive,
          }"
          :aria-selected="mobileConsoleTab === 'logs'"
          @click="mobileConsoleTab = 'logs'"
        >
          Logs
          <span
            v-if="mobileConsoleTab !== 'logs' && progressLive"
            class="faw-m-seg__live"
            aria-label="Log streaming"
          />
        </button>
        <button
          v-if="terminalEnabled"
          type="button"
          role="tab"
          class="faw-m-console-tabs__btn touch-manipulation fx-colors"
          :class="{ 'is-active': mobileConsoleTab === 'terminal' }"
          :aria-selected="mobileConsoleTab === 'terminal'"
          @click="mobileConsoleTab = 'terminal'"
        >
          Terminal
        </button>
      </div>

      <!-- Chat messages (scroll) -->
      <div
        v-show="!mobileTabs || mobileConsoleTab === 'chat'"
        class="faw-console-chat-wrap flex flex-col min-h-0 flex-1 relative"
        :style="
          !mobileTabs && progressOpen
            ? { minHeight: `${CHAT_RESERVE_MIN}px` }
            : undefined
        "
      >
        <div
          ref="chatBox"
          class="faw-console-scroll flex-1 min-h-0 overflow-y-auto"
          role="log"
          aria-relevant="additions"
          :aria-busy="agentTyping || busy ? 'true' : undefined"
          :aria-live="agentTyping ? 'polite' : 'off'"
          @scroll="chatScroll.onScroll"
          @wheel.passive="chatScroll.onWheel"
          @touchmove.passive="chatScroll.onTouchMove"
        >
          <div
            v-for="(m, i) in chat"
            :key="i"
            class="faw-msg"
            :class="m.role === 'user' ? 'user' : m.role === 'agent' ? 'agent' : 'system'"
          >
            <div class="faw-msg__who">{{ m.role === 'user' ? 'You' : m.role }}</div>
            <div class="faw-msg__bubble">
              <ChatMessageBody :role="m.role" :body="m.body" copyable>
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
            </div>
          </div>

          <template v-if="failedSend">
            <div class="faw-msg user faw-msg--failed">
              <div class="faw-msg__who">You</div>
              <div class="faw-msg__bubble faw-msg__bubble--failed">
                <div class="chat-md chat-md-user">{{ failedSend.content }}</div>
                <div class="faw-console-failed-meta">
                  <span class="faw-ba-failed-label">Send failed</span>
                  <button
                    type="button"
                    class="faw-ba-msg-action"
                    aria-label="Retry send"
                    @click="emit('retryFailedSend')"
                  >
                    Retry
                  </button>
                </div>
              </div>
            </div>
            <div class="faw-msg agent faw-msg--failed">
              <div class="faw-msg__who">system</div>
              <div class="faw-msg__bubble faw-msg__bubble--error">
                <p class="m-0 text-[12px]">{{ failedSend.error }}</p>
              </div>
            </div>
          </template>

          <div v-if="agentTyping" class="faw-msg agent">
            <div class="faw-msg__who">agent</div>
            <div
              class="faw-msg__bubble faw-msg__bubble--typing"
              aria-live="polite"
              aria-label="Thinking"
            >
              <span class="chat-typing">
                <span /><span /><span />
              </span>
              <span class="text-[11px] text-ink-faint ml-1.5">thinking…</span>
              <span class="faw-stream-caret" aria-hidden="true" />
            </div>
          </div>

          <a-empty
            v-if="!chat.length && !agentTyping && !failedSend"
            :description="
              currentJob
                ? 'No messages yet — Run or Send'
                : 'Type a request below to start a session'
            "
          />
        </div>
        <button
          v-if="showJumpChat"
          type="button"
          class="faw-console-jump"
          aria-label="Jump to latest message"
          @click="chatScroll.jumpToBottom()"
        >
          Jump to latest
        </button>
      </div>

      <!-- Clarification alert -->
      <div
        v-if="
          (!mobileTabs || mobileConsoleTab === 'chat') &&
          currentJob?.status === 'awaiting_clarification'
        "
        class="shrink-0 px-2 pb-1"
      >
        <a-alert
          type="warning"
          show-icon
          message="Agent is asking — reply in the chat box below to continue"
        />
      </div>

      <!-- Progress / Logs / Terminal — collapse + drag-resize (desktop) -->
      <div
        v-show="
          mobileTabs
            ? mobileConsoleTab === 'logs' || mobileConsoleTab === 'terminal'
            : true
        "
        class="console-progress relative z-[1] flex flex-col min-h-0 overflow-hidden"
        :class="{
          'flex-1': mobileTabs,
          'shrink-0': !mobileTabs,
          'is-dragging': progressDragging,
          'is-collapsed': !mobileTabs && !progressOpen,
        }"
        :style="
          !mobileTabs && progressOpen
            ? {
                height: `${progressHeight}px`,
                maxHeight: `${progressMaxPx}px`,
              }
            : undefined
        "
      >
        <div
          role="toolbar"
          class="console-progress__rail"
          :class="{
            'is-collapsed': !mobileTabs && !progressOpen,
            'is-static': mobileTabs,
          }"
          :title="
            mobileTabs
              ? undefined
              : progressOpen
                ? 'Process/Terminal để đổi · click chỗ khác để đóng · kéo để resize'
                : 'Process / Terminal để mở'
          "
          :aria-expanded="mobileTabs ? undefined : progressOpen"
          @pointerdown="onProgressRailPointerDown"
        >
          <span class="console-progress__grip" aria-hidden="true">
            <i /><i /><i />
          </span>
          <template v-if="!mobileTabs && terminalEnabled">
            <button
              type="button"
              class="console-progress__label console-progress__label--tab"
              :class="{ 'is-on': progressOpen && bottomTab === 'logs' }"
              @pointerdown="onBottomTabPointerDown($event, 'logs')"
            >
              Process
            </button>
            <button
              type="button"
              class="console-progress__label console-progress__label--tab"
              :class="{ 'is-on': progressOpen && bottomTab === 'terminal' }"
              @pointerdown="onBottomTabPointerDown($event, 'terminal')"
            >
              Terminal
            </button>
          </template>
          <span v-else class="console-progress__label">{{
            mobileTabs
              ? mobileConsoleTab === "terminal"
                ? "Terminal"
                : "Logs"
              : "Progress"
          }}</span>
          <span
            v-if="progressLive && (!terminalEnabled || bottomTab === 'logs')"
            class="console-progress__live"
            aria-label="live"
          />
          <span
            v-if="!mobileTabs && !progressOpen && progressLines.length"
            class="console-progress__count"
            >{{ progressLines.length }}</span
          >
          <span class="flex-1" />
          <template v-if="mobileTabs || progressOpen">
            <button
              type="button"
              class="faw-console-log-tool"
              :class="{ 'is-on': progressErrorsOnly }"
              title="Show errors and warnings only"
              @pointerdown.stop
              @click.stop="progressErrorsOnly = !progressErrorsOnly"
            >
              Errors
            </button>
            <button
              type="button"
              class="faw-console-log-tool"
              title="Copy visible log"
              @pointerdown.stop
              @click.stop="copyVisibleProgress"
            >
              Copy
            </button>
          </template>
          <DownOutlined
            v-if="!mobileTabs"
            class="console-progress__chevron"
            :class="{ 'is-open': progressOpen }"
          />
        </div>

        <div
          v-show="
            (mobileTabs || progressOpen) &&
            (mobileTabs
              ? mobileConsoleTab === 'logs'
              : !terminalEnabled || bottomTab === 'logs')
          "
          class="faw-console-progress-wrap relative flex-1 min-h-0 flex flex-col"
        >
          <div
            ref="progressBox"
            class="console-progress__body flex-1 min-h-0 overflow-y-auto space-y-0"
            :class="mobileTabs ? 'text-xs' : ''"
            role="log"
            aria-relevant="additions"
            :aria-busy="progressLive ? 'true' : undefined"
            :aria-live="progressLive ? 'polite' : 'off'"
            @scroll="progressScroll.onScroll"
            @wheel.passive="progressScroll.onWheel"
            @touchmove.passive="progressScroll.onTouchMove"
          >
            <div
              v-for="l in visibleProgressLines"
              :key="l.id"
              class="mb-1.5 last:mb-0"
            >
              <div class="flex items-center gap-1.5 mb-0.5 opacity-70">
                <span
                  class="text-[9px] font-semibold uppercase tracking-wide"
                  :class="{
                    'text-amber-700': l.kind === 'task',
                    'text-sky-700': l.kind === 'tool',
                  }"
                  >{{
                    l.kind === "task"
                      ? "SUBAGENT"
                      : l.kind === "tool"
                        ? "TOOL"
                        : l.kind
                  }}</span
                >
                <span class="text-[9px]">{{
                  new Date(l.at).toLocaleTimeString()
                }}</span>
              </div>
              <div
                class="leading-snug break-words whitespace-pre-wrap overflow-y-auto text-[10.5px]"
                :class="
                  l.kind === 'assistant' ||
                  l.kind === 'thinking' ||
                  l.kind === 'task' ||
                  l.kind === 'prompt'
                    ? 'max-h-[min(70vh,28rem)]'
                    : 'max-h-36'
                "
              >
                {{ l.text }}
              </div>
            </div>
            <div
              v-if="!visibleProgressLines.length"
              class="text-center py-4 text-[11px] font-sans opacity-60"
            >
              {{
                progressErrorsOnly
                  ? "No error lines in this log"
                  : progressLive
                    ? "Waiting for Cursor stream…"
                    : "No progress yet"
              }}
            </div>
          </div>
          <button
            v-if="showJumpProgress"
            type="button"
            class="faw-console-jump faw-console-jump--progress"
            aria-label="Jump to latest log"
            @click="progressScroll.jumpToBottom()"
          >
            Jump to latest
          </button>
        </div>

        <div
          v-if="terminalEnabled"
          v-show="
            (mobileTabs && mobileConsoleTab === 'terminal') ||
            (!mobileTabs && progressOpen && bottomTab === 'terminal')
          "
          class="flex-1 min-h-0 overflow-hidden"
        >
          <RepoTerminal
            :active="
              (mobileTabs && mobileConsoleTab === 'terminal') ||
              (!mobileTabs && progressOpen && bottomTab === 'terminal')
            "
          />
        </div>
      </div>

      <!-- Composer — sticky bottom -->
      <div
        v-show="!mobileTabs || mobileConsoleTab === 'chat'"
        class="faw-console-input"
      >
        <a-textarea
          :value="chatInput"
          :rows="1"
          :auto-size="{ minRows: 1, maxRows: 12 }"
          :autofocus="false"
          :disabled="false"
          :readonly="false"
          aria-label="Agent console message"
          :placeholder="
            agentTyping || busy
              ? 'Follow-up — Send will stop the current run first…'
              : currentJob?.status === 'awaiting_clarification'
                ? 'Reply to the agent…'
                : currentJob
                  ? 'Command or question…'
                  : 'Describe work — Send starts a session'
          "
          @update:value="(v: string) => emit('update:chatInput', v)"
          @keydown="onChatKeydown"
        />
        <div class="faw-console-input__row faw-ba-input-row">
          <span class="faw-ba-input-hint faw-ba-input-hint--desktop">
            Enter / ⌘·Ctrl+Enter send · Shift+Enter newline · Esc stop
          </span>
          <span class="faw-ba-input-hint faw-ba-input-hint--mobile">
            Enter send · Esc stop
          </span>
          <div class="faw-ba-input-actions">
            <a-select
              class="faw-agent-mode-select"
              size="small"
              option-label-prop="label"
              :value="agentRunMode"
              :disabled="stopBusy"
              :dropdown-match-select-width="false"
              @update:value="onAgentRunMode"
            >
              <a-select-option value="agent" label="Agent">
                <div class="faw-agent-mode-opt">
                  <span class="faw-agent-mode-opt__title">Agent</span>
                  <span class="faw-agent-mode-opt__desc"
                    >Implement / fix in the checkout</span
                  >
                </div>
              </a-select-option>
              <a-select-option value="plan" label="Plan">
                <div class="faw-agent-mode-opt">
                  <span class="faw-agent-mode-opt__title">Plan</span>
                  <span class="faw-agent-mode-opt__desc"
                    >Explore & write a plan only (Approve Plan → code)</span
                  >
                </div>
              </a-select-option>
            </a-select>
            <a-tooltip
              title="Agent = code/fix. Plan = Cursor plan mode only → Approve Plan → code. Docs-first (Dev Notes) is separate: read → code → update docs."
            >
              <ExclamationCircleOutlined
                class="text-[var(--app-faint)] text-[12px] cursor-help shrink-0"
              />
            </a-tooltip>
            <button
              type="button"
              class="faw-btn faw-btn--run faw-btn--send"
              :disabled="!chatInput.trim() || stopBusy || sendBusy"
              :title="
                planFirst
                  ? 'Queue plan-only run (Cursor plan mode)'
                  : 'Queue command — agent runs in the background'
              "
              @click="emit('sendChat', 'continue')"
            >
              {{ sendBusy ? "Sending…" : "Send" }}
            </button>
            <button
              type="button"
              class="faw-btn faw-btn--ask"
              :disabled="!chatInput.trim() || stopBusy || sendBusy"
              title="Quick Q&A (no code changes) → queue"
              @click="emit('sendChat', 'ask')"
            >
              Ask
            </button>
          </div>
        </div>
      </div>
    </template>
  </aside>
</template>
