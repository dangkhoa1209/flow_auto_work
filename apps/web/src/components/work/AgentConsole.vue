<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { DownOutlined } from "@ant-design/icons-vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import RepoTerminal from "@/components/work/RepoTerminal.vue";
import { useAutoScroll } from "@/composables/useAutoScroll";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import {
  statusLabel,
  contextQualityLabel,
} from "@/utils/status";
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
    stopBusy: boolean;
    canForceStop: boolean;
    canResetWindow: boolean;
    agentWindowShort: string | null;
    contextQuality: Job["contextQuality"] | null;
    /** Mobile: Chat | Logs tabs instead of split panes */
    mobileTabs?: boolean;
  }>(),
  { mobileTabs: false },
);

const emit = defineEmits<{
  "update:chatInput": [string];
  sendChat: ["continue" | "ask"];
  forceStop: [];
  resetWindow: [];
}>();

/** Enter → Send; Shift+Enter → newline (IME composition ignored). */
function onChatKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter") return;
  if (e.isComposing) return;
  if (e.shiftKey) return;
  e.preventDefault();
  if (props.busy || props.agentTyping) return;
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
]);
const lastProgress = () => props.progressLines.at(-1);
const progressScroll = useAutoScroll(progressBox, () => [
  props.progressLines.length,
  lastProgress()?.id,
  lastProgress()?.text,
]);

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
    :class="{ 'select-none': progressDragging }"
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
      <!-- Header / toolbar — mockup console-head -->
      <div ref="headerEl" class="faw-console-head">
        <div class="faw-console-head__title">
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
        <div class="faw-console-actions">
          <template v-if="terminalEnabled">
            <button
              type="button"
              class="faw-btn"
              :class="{
                'faw-btn--run':
                  (!mobileTabs && progressOpen && bottomTab === 'logs') ||
                  (mobileTabs && mobileConsoleTab === 'logs'),
              }"
              title="Xem Process / agent progress"
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
                  (!mobileTabs && progressOpen && bottomTab === 'terminal') ||
                  (mobileTabs && mobileConsoleTab === 'terminal'),
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
          <span
            v-if="currentJob"
            class="faw-chip"
            :class="{
              'faw-chip--good': currentJob.status === 'succeeded',
              'faw-chip--wip':
                currentJob.status === 'running' ||
                currentJob.status === 'queued' ||
                currentJob.status.startsWith('awaiting_'),
              'faw-chip--bug': currentJob.status === 'failed',
            }"
            >{{ statusLabel(currentJob.status) }}</span
          >
          <span
            v-if="contextQuality?.level === 'good'"
            class="faw-btn faw-btn--run"
            style="flex: none; padding: 4px 8px; cursor: default"
            :title="contextQuality.reason || ''"
            >Good context</span
          >
          <span
            v-else-if="contextQuality?.level"
            class="faw-chip"
            :title="contextQuality.reason || ''"
            >{{ contextQualityLabel(contextQuality.level) }}</span
          >
        </div>
      </div>

      <!-- Mobile: Chat | Logs | Terminal switcher -->
      <div
        v-if="mobileTabs"
        class="faw-m-console-tabs shrink-0"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          class="faw-m-console-tabs__btn touch-manipulation fx-colors"
          :class="{ 'is-active': mobileConsoleTab === 'chat' }"
          :aria-selected="mobileConsoleTab === 'chat'"
          @click="mobileConsoleTab = 'chat'"
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          class="faw-m-console-tabs__btn touch-manipulation fx-colors"
          :class="{ 'is-active': mobileConsoleTab === 'logs' }"
          :aria-selected="mobileConsoleTab === 'logs'"
          @click="mobileConsoleTab = 'logs'"
        >
          Logs
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
        class="flex flex-col min-h-0 flex-1"
        :style="
          !mobileTabs && progressOpen
            ? { minHeight: `${CHAT_RESERVE_MIN}px` }
            : undefined
        "
      >
        <div
          ref="chatBox"
          class="faw-console-scroll flex-1 min-h-0 overflow-y-auto"
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
              <ChatMessageBody :role="m.role" :body="m.body" />
              <time
                v-if="formatChatTime(m.createdAt)"
                class="faw-msg__time"
                :datetime="m.createdAt"
              >
                {{ formatChatTime(m.createdAt) }}
              </time>
            </div>
          </div>

          <div v-if="agentTyping" class="faw-msg agent">
            <div class="faw-msg__who">agent</div>
            <div class="faw-msg__bubble faw-msg__bubble--typing">
              <span class="chat-typing" aria-label="Đang suy nghĩ">
                <span /><span /><span />
              </span>
              <span class="text-[11px] text-ink-faint ml-1.5">đang suy nghĩ…</span>
            </div>
          </div>

          <a-empty
            v-if="!chat.length && !agentTyping"
            description="Chat trống — Run hoặc Gửi"
          />
        </div>
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
          message="Agent đang hỏi — trả lời ở ô chat bên dưới để tiếp tục"
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
          ref="progressBox"
          class="console-progress__body flex-1 min-h-0 overflow-y-auto space-y-0"
          :class="mobileTabs ? 'text-xs' : ''"
          @scroll="progressScroll.onScroll"
          @wheel.passive="progressScroll.onWheel"
          @touchmove.passive="progressScroll.onTouchMove"
        >
          <div
            v-for="l in progressLines"
            :key="l.id"
            class="mb-1.5 last:mb-0"
          >
            <div class="flex items-center gap-1.5 mb-0.5 opacity-70">
              <span class="text-[9px] font-semibold uppercase tracking-wide"
                >{{ l.kind }}</span
              >
              <span class="text-[9px]">{{
                new Date(l.at).toLocaleTimeString()
              }}</span>
            </div>
            <div
              class="leading-snug break-words whitespace-pre-wrap max-h-36 overflow-y-auto text-[10.5px]"
            >
              {{ l.text }}
            </div>
          </div>
          <div
            v-if="!progressLines.length"
            class="text-center py-4 text-[11px] font-sans opacity-60"
          >
            {{ progressLive ? "Waiting for Cursor stream…" : "No progress yet" }}
          </div>
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
          :rows="2"
          :auto-size="{ minRows: 2, maxRows: 12 }"
          :autofocus="false"
          :disabled="false"
          :readonly="busy || agentTyping"
          :placeholder="
            agentTyping || busy
              ? 'Agent đang suy nghĩ… đợi xong hoặc Force Stop'
              : currentJob?.status === 'awaiting_clarification'
                ? 'Trả lời agent / xác nhận…'
                : 'Gửi lệnh (sửa / làm / phân tích) → xếp queue…'
          "
          @update:value="(v: string) => emit('update:chatInput', v)"
          @keydown="onChatKeydown"
        />
        <div class="faw-console-input__row faw-ba-input-row">
          <span class="faw-ba-input-hint">
            Enter gửi · Shift+Enter xuống dòng
          </span>
          <div class="faw-ba-input-actions">
            <button
              type="button"
              class="faw-btn faw-btn--run faw-btn--send"
              :disabled="busy || agentTyping"
              title="Xếp lệnh vào queue — agent chạy nền (không chờ HTTP)"
              @click="emit('sendChat', 'continue')"
            >
              Send
            </button>
            <button
              type="button"
              class="faw-btn faw-btn--ask"
              :disabled="busy || agentTyping"
              title="Hỏi nhanh (Q&A, không sửa code) → xếp queue"
              @click="emit('sendChat', 'ask')"
            >
              Ask only
            </button>
          </div>
        </div>
      </div>
    </template>
  </aside>
</template>
