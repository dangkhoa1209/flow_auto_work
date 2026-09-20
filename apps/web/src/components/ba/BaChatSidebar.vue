<script setup lang="ts">
import { computed, inject, nextTick, ref } from "vue";
import { Modal, message } from "ant-design-vue";
import {
  PlusOutlined,
  DeleteOutlined,
  SearchOutlined,
  PushpinOutlined,
  PushpinFilled,
  EditOutlined,
} from "@ant-design/icons-vue";
import { useBaChatStore, type BaThread } from "@/stores/baChat";
import { formatRelativeTime } from "@/utils/formatChatTime";

const ba = useBaChatStore();
const closeSide = inject<() => void>("baCloseSide", () => undefined);

const threadQuery = ref("");
const renamingId = ref<string | null>(null);
const renameDraft = ref("");
const renameInputEl = ref<HTMLInputElement | null>(null);
const threadListEl = ref<HTMLElement | null>(null);

const showSearch = computed(() => ba.threads.length >= 8);

const filteredThreads = computed(() => {
  const q = threadQuery.value.trim().toLowerCase();
  if (!q) return ba.threads;
  return ba.threads.filter((t) => t.title.toLowerCase().includes(q));
});

/** Last message snippet for the active thread (others load on select). */
const activeSnippet = computed(() => {
  const msgs = ba.messages;
  if (!msgs.length) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i]?.content?.trim();
    if (c) {
      const oneLine = c.replace(/\s+/g, " ");
      return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
    }
  }
  return "";
});

async function onNewChat() {
  try {
    await ba.newChat();
    closeSide();
  } catch (e) {
    message.warning(e instanceof Error ? e.message : String(e));
  }
}

function onSelectThread(id: string) {
  if (renamingId.value === id) return;
  ba.selectThread(id);
  closeSide();
}

function startRename(t: BaThread, e?: Event) {
  e?.stopPropagation();
  renamingId.value = t.id;
  renameDraft.value = t.title;
  void nextTick(() => {
    renameInputEl.value?.focus();
    renameInputEl.value?.select();
  });
}

function cancelRename() {
  renamingId.value = null;
  renameDraft.value = "";
}

async function commitRename() {
  const id = renamingId.value;
  if (!id) return;
  const next = renameDraft.value.trim();
  const prev = ba.threads.find((t) => t.id === id)?.title || "";
  // Clear immediately so blur cannot double-fire while the PATCH is in flight.
  renamingId.value = null;
  renameDraft.value = "";
  if (!next || next === prev) return;
  try {
    await ba.renameThread(id, next);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onTogglePin(t: BaThread, e: Event) {
  e.stopPropagation();
  try {
    await ba.setThreadPinned(t.id, !t.pinned);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function onDelete(id: string, title: string) {
  Modal.confirm({
    title: "Delete this chat?",
    content: title,
    okType: "danger",
    okText: "Delete",
    cancelText: "Cancel",
    onOk: async () => {
      try {
        await ba.deleteThread(id);
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

function onThreadListScroll() {
  const el = threadListEl.value;
  if (!el || ba.threadsLoadingMore || !ba.threadsHasMore) return;
  // Load next page when within ~80px of the bottom.
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
    void ba.loadMoreThreads();
  }
}
</script>

<template>
  <aside class="faw-col faw-ba-side flex flex-col min-h-0 overflow-hidden h-full">
    <div class="faw-col-head">
      <h2>Chats</h2>
      <span class="faw-count"
        >{{ ba.threads.length
        }}{{ ba.threadsHasMore ? "+" : "" }}</span
      >
    </div>

    <div class="faw-filters faw-ba-filters">
      <a-tooltip
        :title="
          !ba.selectedProjectId
            ? 'Select a project in the top bar'
            : !ba.projectReady
              ? 'Project is not ready yet — ask an admin'
              : 'Start a new conversation'
        "
      >
        <button
          type="button"
          class="faw-btn faw-btn--run faw-ba-new"
          :disabled="!ba.projectReady || ba.streaming"
          @click="onNewChat"
        >
          <PlusOutlined /> New Chat
        </button>
      </a-tooltip>
      <div v-if="showSearch" class="faw-ba-thread-search">
        <SearchOutlined class="faw-ba-thread-search__icon" aria-hidden="true" />
        <input
          v-model="threadQuery"
          type="search"
          class="faw-ba-thread-search__input"
          placeholder="Filter chats…"
          aria-label="Filter chats"
        />
      </div>
    </div>

    <div
      ref="threadListEl"
      class="flex-1 min-h-0 overflow-y-auto"
      @scroll.passive="onThreadListScroll"
    >
      <div
        v-if="!ba.threads.length"
        class="px-3 py-10 text-center text-[11px] text-[var(--app-faint)]"
      >
        No chats yet.<br />Click
        <b class="text-[var(--app-muted)]">New Chat</b> to start.
      </div>
      <div
        v-else-if="!filteredThreads.length"
        class="px-3 py-8 text-center text-[11px] text-[var(--app-faint)]"
      >
        No chats match “{{ threadQuery.trim() }}”
      </div>
      <div
        v-for="t in filteredThreads"
        :key="t.id"
        role="button"
        tabindex="0"
        class="faw-ba-thread"
        :class="{
          active: t.id === ba.activeThreadId,
          'faw-ba-thread--pinned': t.pinned,
        }"
        @click="onSelectThread(t.id)"
        @keydown.enter.prevent="onSelectThread(t.id)"
        @dblclick.stop="startRename(t)"
      >
        <div class="faw-ba-thread__main">
          <template v-if="renamingId === t.id">
            <input
              :ref="
                (el) => {
                  renameInputEl.value = (el as HTMLInputElement | null) || null;
                }
              "
              v-model="renameDraft"
              type="text"
              class="faw-ba-thread__rename"
              maxlength="120"
              aria-label="Rename chat"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <span class="faw-ba-thread__title">
              <PushpinFilled
                v-if="t.pinned"
                class="faw-ba-thread__pin-mark"
                aria-hidden="true"
              />
              {{ t.title }}
            </span>
            <span
              v-if="t.id === ba.activeThreadId && activeSnippet"
              class="faw-ba-thread__snip"
              >{{ activeSnippet }}</span
            >
            <span class="faw-ba-thread__time">{{
              formatRelativeTime(t.updatedAt)
            }}</span>
          </template>
        </div>
        <div
          v-if="renamingId !== t.id"
          class="faw-ba-thread__actions"
          @click.stop
        >
          <button
            type="button"
            class="faw-icon-btn"
            :title="t.pinned ? 'Unpin' : 'Pin'"
            :aria-label="t.pinned ? 'Unpin chat' : 'Pin chat'"
            @click="onTogglePin(t, $event)"
          >
            <PushpinFilled v-if="t.pinned" />
            <PushpinOutlined v-else />
          </button>
          <button
            type="button"
            class="faw-icon-btn"
            title="Rename"
            aria-label="Rename chat"
            @click="startRename(t, $event)"
          >
            <EditOutlined />
          </button>
          <button
            type="button"
            class="faw-icon-btn faw-ba-thread__del"
            title="Delete"
            aria-label="Delete chat"
            @click="onDelete(t.id, t.title)"
          >
            <DeleteOutlined />
          </button>
        </div>
      </div>
      <div
        v-if="ba.threadsLoadingMore"
        class="px-3 py-3 text-center text-[11px] text-[var(--app-faint)]"
        aria-live="polite"
      >
        Loading more…
      </div>
      <div
        v-else-if="ba.threadsHasMore && ba.threads.length"
        class="px-3 py-2 text-center text-[10px] text-[var(--app-faint)]"
      >
        Scroll for more
      </div>
    </div>
  </aside>
</template>
