<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ClearOutlined,
  PauseCircleOutlined,
  DownOutlined,
} from "@ant-design/icons-vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import { useAutoScroll } from "@/composables/useAutoScroll";
import {
  statusLabel,
  statusColor,
  contextQualityLabel,
  contextQualityColor,
} from "@/utils/status";
import type { Job } from "@/stores/work";

const PROGRESS_OPEN_KEY = "flow.console.progressOpen";
const PROGRESS_H_KEY = "flow.console.progressHeight";
const PROGRESS_H_MIN = 120;
const PROGRESS_H_DEFAULT = 240;
/** Keep chat (messages strip + composer) usable when Process is expanded. */
const CHAT_RESERVE_MIN = 200;
const HEADER_FALLBACK = 48;

const props = withDefaults(
  defineProps<{
    jobLoading: boolean;
    currentJob: Job | null;
    chat: Array<{ role: string; body: string }>;
    agentTyping: boolean;
    progressLines: Array<{
      id: number;
      at: string;
      kind: string;
      text: string;
    }>;
    progressLive: boolean;
    chatInput: string;
    clarifyInput: string;
    busy: boolean;
    stopBusy: boolean;
    canForceStop: boolean;
    canResetWindow: boolean;
    agentWindowShort: string | null;
    pendingClarify: string | null;
    contextQuality: Job["contextQuality"] | null;
    /** Mobile: Chat | Logs tabs instead of split panes */
    mobileTabs?: boolean;
  }>(),
  { mobileTabs: false },
);

const emit = defineEmits<{
  "update:chatInput": [string];
  "update:clarifyInput": [string];
  sendChat: ["continue" | "ask"];
  sendClarify: [];
  forceStop: [];
  resetWindow: [];
}>();

const rootEl = ref<HTMLElement | null>(null);
const headerEl = ref<HTMLElement | null>(null);
const chatBox = ref<HTMLElement | null>(null);
const progressBox = ref<HTMLElement | null>(null);
const mobileConsoleTab = ref<"chat" | "logs">("chat");
const progressOpen = ref(true);
const progressHeight = ref(PROGRESS_H_DEFAULT);
const progressMaxPx = ref(PROGRESS_H_DEFAULT);
const progressDragging = ref(false);

let dragStartY = 0;
let dragStartH = 0;
let dragMoved = false;
let dragPointerId: number | null = null;
let rootResizeObserver: ResizeObserver | null = null;

onMounted(() => {
  try {
    const raw = localStorage.getItem(PROGRESS_OPEN_KEY);
    if (raw === "0" || raw === "false") progressOpen.value = false;
    else if (raw === "1" || raw === "true") progressOpen.value = true;
    const h = Number(localStorage.getItem(PROGRESS_H_KEY));
    if (Number.isFinite(h) && h >= PROGRESS_H_MIN) {
      progressHeight.value = Math.round(h);
    }
  } catch {
    /* ignore */
  }
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
  // Never let Process eat into chat — leave header + min chat room.
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

function toggleProgress() {
  progressOpen.value = !progressOpen.value;
}

function onProgressRailPointerDown(e: PointerEvent) {
  if (props.mobileTabs || e.button !== 0) return;
  if (!progressOpen.value) {
    progressOpen.value = true;
    return;
  }
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
    toggleProgress();
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
});

const chatScroll = useAutoScroll(chatBox, () => [
  props.chat.length,
  props.agentTyping,
]);
const progressScroll = useAutoScroll(progressBox, () => props.progressLines.length);
</script>

<template>
  <aside
    ref="rootEl"
    class="flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel relative h-full"
    :class="{ 'select-none': progressDragging }"
  >
    <div
      v-if="jobLoading"
      class="absolute inset-0 z-20 rounded-2xl bg-surface-raised p-3 space-y-2.5 border border-line"
      aria-busy="true"
    >
      <div class="skel h-4 w-36" />
      <div class="skel h-14 w-full" />
      <div class="skel h-10 w-[90%]" />
      <div class="skel h-10 w-[80%]" />
      <div class="skel h-10 w-[70%]" />
      <div class="skel h-28 w-full mt-3" />
      <div class="skel h-8 w-full mt-auto" />
    </div>

    <template v-if="!jobLoading">
      <!-- Header / toolbar -->
      <div
        ref="headerEl"
        class="shrink-0 px-3 py-2.5 border-b border-line flex items-center justify-between gap-2 bg-gradient-to-r from-accent-soft/60 to-transparent"
      >
        <div class="min-w-0">
          <div class="font-semibold text-sm text-ink">Agent console</div>
          <div
            v-if="agentWindowShort"
            class="text-[10px] font-mono text-ink-faint truncate"
            :title="currentJob?.agentId || ''"
          >
            window {{ agentWindowShort }}
          </div>
          <div v-else class="text-[10px] text-ink-faint">chưa gắn window</div>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap justify-end shrink-0">
          <a-popconfirm
            v-if="canForceStop"
            title="Force Stop agent?"
            ok-text="Stop"
            cancel-text="Huỷ"
            ok-type="danger"
            @confirm="emit('forceStop')"
          >
            <a-button
              size="small"
              danger
              :loading="stopBusy"
              :disabled="stopBusy"
            >
              <template #icon><PauseCircleOutlined /></template>
              Stop
            </a-button>
          </a-popconfirm>
          <a-popconfirm
            v-if="canResetWindow"
            title="Reset agent window?"
            ok-text="Reset"
            cancel-text="Huỷ"
            ok-type="danger"
            @confirm="emit('resetWindow')"
          >
            <template #description>
              Dừng run nếu đang chạy, xóa liên kết cửa sổ Cursor cũ. Chat lịch sử
              vẫn giữ.
            </template>
            <a-button size="small" :loading="busy" :disabled="!currentJob">
              <template #icon><ClearOutlined /></template>
              Reset
            </a-button>
          </a-popconfirm>
          <a-tag v-if="currentJob" :color="statusColor(currentJob.status)">{{
            statusLabel(currentJob.status)
          }}</a-tag>
          <a-tag
            v-if="contextQuality?.level"
            :color="contextQualityColor(contextQuality.level)"
            :title="contextQuality.reason || ''"
            >{{ contextQualityLabel(contextQuality.level) }}</a-tag
          >
        </div>
      </div>

      <!-- Mobile: Chat | Logs switcher -->
      <div
        v-if="mobileTabs"
        class="shrink-0 flex gap-0.5 p-1 border-b border-line bg-surface-soft/80"
      >
        <button
          type="button"
          class="flex-1 h-8 rounded-md text-xs font-medium fx-colors touch-manipulation"
          :class="
            mobileConsoleTab === 'chat'
              ? 'bg-surface-raised text-accent shadow-sm'
              : 'text-ink-muted'
          "
          @click="mobileConsoleTab = 'chat'"
        >
          Chat
        </button>
        <button
          type="button"
          class="flex-1 h-8 rounded-md text-xs font-medium fx-colors touch-manipulation"
          :class="
            mobileConsoleTab === 'logs'
              ? 'bg-surface-raised text-accent shadow-sm'
              : 'text-ink-muted'
          "
          @click="mobileConsoleTab = 'logs'"
        >
          Logs
        </button>
      </div>

      <!-- Chat panel -->
      <div
        v-show="!mobileTabs || mobileConsoleTab === 'chat'"
        class="flex flex-col min-h-0 border-b border-line flex-1"
        :style="
          !mobileTabs && progressOpen
            ? { minHeight: `${CHAT_RESERVE_MIN}px` }
            : undefined
        "
      >
        <div
          ref="chatBox"
          class="flex-1 min-h-0 overflow-y-auto p-3 space-y-2"
          @scroll="chatScroll.onScroll"
        >
          <div
            v-for="(m, i) in chat"
            :key="i"
            class="rounded-xl px-3 py-2 border transition break-words"
            :class="[
              mobileTabs ? 'text-xs' : 'text-sm',
              m.role === 'user'
                ? 'bg-accent-soft border-accent/20 ml-4 text-ink'
                : m.role === 'agent'
                  ? 'bg-surface-raised border-line mr-2 text-ink-soft'
                  : 'bg-surface-muted border-transparent text-ink-muted',
            ]"
          >
            <div
              class="text-[10px] uppercase tracking-wide text-ink-faint font-semibold mb-1"
            >
              {{ m.role }}
            </div>
            <ChatMessageBody :role="m.role" :body="m.body" />
          </div>

          <div
            v-if="agentTyping"
            class="rounded-xl px-3 py-2.5 text-sm border border-line bg-surface-raised mr-2 inline-flex items-center gap-2"
          >
            <span
              class="text-[10px] uppercase tracking-wide text-ink-faint font-semibold"
              >agent</span
            >
            <span class="chat-typing" aria-label="Đang suy nghĩ">
              <span /><span /><span />
            </span>
            <span class="text-xs text-ink-faint">đang suy nghĩ…</span>
          </div>

          <a-empty
            v-if="!chat.length && !agentTyping"
            description="Chat trống — Run hoặc Gửi"
          />
        </div>

        <div v-if="pendingClarify" class="shrink-0 px-3 pb-2">
          <a-alert type="warning" show-icon :message="pendingClarify" />
          <a-textarea
            :value="clarifyInput"
            class="mt-2"
            :rows="2"
            :autofocus="false"
            placeholder="Trả lời clarify…"
            @update:value="(v: string) => emit('update:clarifyInput', v)"
          />
          <a-button
            type="primary"
            size="small"
            class="mt-1"
            :loading="busy"
            @click="emit('sendClarify')"
            >Gửi clarify</a-button
          >
        </div>

        <div
          class="shrink-0 p-2 sm:p-3 border-t border-line space-y-2 bg-surface-soft/70"
        >
          <a-textarea
            :value="chatInput"
            :rows="2"
            :autofocus="false"
            :disabled="busy || agentTyping"
            placeholder="Hỏi / sửa / làm thêm (IDE follow-up)…"
            @update:value="(v: string) => emit('update:chatInput', v)"
            @keydown.meta.enter="emit('sendChat', 'continue')"
          />
          <div class="flex gap-2">
            <a-button
              type="primary"
              size="small"
              class="flex-1"
              :loading="busy || agentTyping"
              :disabled="busy || agentTyping"
              @click="emit('sendChat', 'continue')"
              >Gửi</a-button
            >
            <a-button
              size="small"
              :loading="busy || agentTyping"
              :disabled="busy || agentTyping"
              @click="emit('sendChat', 'ask')"
              >Chỉ hỏi</a-button
            >
          </div>
        </div>
      </div>

      <!-- Progress / Logs — collapse + drag-resize (desktop) -->
      <div
        v-show="mobileTabs ? mobileConsoleTab === 'logs' : true"
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
        <button
          type="button"
          class="console-progress__rail"
          :class="{
            'is-collapsed': !mobileTabs && !progressOpen,
            'is-static': mobileTabs,
          }"
          :title="
            mobileTabs
              ? undefined
              : progressOpen
                ? 'Kéo để đổi chiều cao · click để thu gọn'
                : 'Mở Progress'
          "
          :aria-expanded="mobileTabs ? undefined : progressOpen"
          @pointerdown="onProgressRailPointerDown"
        >
          <span class="console-progress__grip" aria-hidden="true">
            <i /><i /><i />
          </span>
          <span class="console-progress__label">{{
            mobileTabs ? "Logs" : "Progress"
          }}</span>
          <span
            v-if="progressLive"
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
        </button>

        <div
          v-show="mobileTabs || progressOpen"
          ref="progressBox"
          class="console-progress__body flex-1 min-h-0 overflow-y-auto p-2.5 space-y-1 font-mono text-gray-100 leading-snug"
          :class="mobileTabs ? 'text-xs' : ''"
          @scroll="progressScroll.onScroll"
        >
          <div
            v-for="l in progressLines"
            :key="l.id"
            class="rounded border border-gray-700/60 bg-gray-800/50 px-2 py-1"
          >
            <div class="flex items-center gap-2 mb-0.5">
              <span
                class="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
                :class="{
                  'bg-violet-900/80 text-violet-200': l.kind === 'thinking',
                  'bg-sky-900/80 text-sky-200': l.kind === 'assistant',
                  'bg-amber-900/80 text-amber-200': l.kind === 'tool',
                  'bg-emerald-900/80 text-emerald-200':
                    l.kind === 'status' || l.kind === 'usage',
                  'bg-gray-700 text-gray-300':
                    l.kind !== 'thinking' &&
                    l.kind !== 'assistant' &&
                    l.kind !== 'tool' &&
                    l.kind !== 'status' &&
                    l.kind !== 'usage',
                }"
                >{{ l.kind }}</span
              >
              <span class="text-[10px] text-gray-500">{{
                new Date(l.at).toLocaleTimeString()
              }}</span>
            </div>
            <div
              class="leading-snug text-gray-200/90 break-words whitespace-pre-wrap max-h-40 overflow-y-auto"
              :class="mobileTabs ? 'text-xs' : 'text-[11px]'"
            >
              {{ l.text }}
            </div>
          </div>
          <div
            v-if="!progressLines.length"
            class="text-gray-500 text-center py-8 text-sm font-sans"
          >
            {{ progressLive ? "Đang chờ Cursor stream…" : "Chưa có progress" }}
          </div>
        </div>
      </div>
    </template>
  </aside>
</template>
