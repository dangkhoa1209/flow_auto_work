<script setup lang="ts">
import { computed, inject, nextTick, ref } from "vue";
import { Modal, message } from "ant-design-vue";
import { PlusOutlined, SearchOutlined, CloseOutlined } from "@ant-design/icons-vue";
import { useBaChatStore, type BaThread } from "@/stores/baChat";
import BaThreadRow from "@/components/ba/BaThreadRow.vue";

const ba = useBaChatStore();
const closeSide = inject<() => void>("baCloseSide", () => undefined);

const threadQuery = ref("");
const renamingId = ref<string | null>(null);
const renameDraft = ref("");
const renameInputEl = ref<HTMLInputElement | null>(null);
const threadListEl = ref<HTMLElement | null>(null);

const showSearch = computed(() => ba.threads.length >= 3);

const filteredThreads = computed(() => {
  const q = threadQuery.value.trim().toLowerCase();
  if (!q) return ba.threads;
  return ba.threads.filter((t) => t.title.toLowerCase().includes(q));
});

const pinnedThreads = computed(() =>
  filteredThreads.value.filter((t) => t.pinned),
);
const recentThreads = computed(() =>
  filteredThreads.value.filter((t) => !t.pinned),
);

const showGroups = computed(
  () => pinnedThreads.value.length > 0 && recentThreads.value.length > 0,
);

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

function setRenameEl(el: HTMLInputElement | null) {
  renameInputEl.value = el;
}
</script>

<template>
  <aside
    id="faw-ba-thread-drawer"
    class="faw-col faw-ba-side flex flex-col min-h-0 overflow-hidden h-full"
  >
    <div class="faw-col-head">
      <h2>Chats</h2>
      <span class="faw-count"
        >{{ ba.threads.length
        }}{{ ba.threadsHasMore ? "+" : "" }}</span
      >
      <button
        type="button"
        class="faw-icon-btn faw-ba-side__close lg:hidden"
        aria-label="Close chats"
        title="Close"
        @click="closeSide()"
      >
        <CloseOutlined />
      </button>
    </div>

    <div class="faw-filters faw-ba-filters faw-ba-filters--sticky">
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
          placeholder="Search chats…"
          aria-label="Search chats"
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
      <template v-else>
        <template v-if="showGroups">
          <div class="faw-ba-thread-group" aria-label="Pinned chats">
            <div class="faw-ba-thread-group__label">Pinned</div>
            <BaThreadRow
              v-for="t in pinnedThreads"
              :key="t.id"
              :thread="t"
              :active="t.id === ba.activeThreadId"
              :snippet="t.id === ba.activeThreadId ? activeSnippet : ''"
              :renaming="renamingId === t.id"
              :rename-draft="renameDraft"
              @select="onSelectThread"
              @start-rename="startRename"
              @commit-rename="commitRename"
              @cancel-rename="cancelRename"
              @update:rename-draft="renameDraft = $event"
              @set-rename-el="setRenameEl"
              @toggle-pin="onTogglePin"
              @delete="onDelete"
            />
          </div>
          <div class="faw-ba-thread-group" aria-label="Recent chats">
            <div class="faw-ba-thread-group__label">Recent</div>
            <BaThreadRow
              v-for="t in recentThreads"
              :key="t.id"
              :thread="t"
              :active="t.id === ba.activeThreadId"
              :snippet="t.id === ba.activeThreadId ? activeSnippet : ''"
              :renaming="renamingId === t.id"
              :rename-draft="renameDraft"
              @select="onSelectThread"
              @start-rename="startRename"
              @commit-rename="commitRename"
              @cancel-rename="cancelRename"
              @update:rename-draft="renameDraft = $event"
              @set-rename-el="setRenameEl"
              @toggle-pin="onTogglePin"
              @delete="onDelete"
            />
          </div>
        </template>
        <template v-else>
          <BaThreadRow
            v-for="t in filteredThreads"
            :key="t.id"
            :thread="t"
            :active="t.id === ba.activeThreadId"
            :snippet="t.id === ba.activeThreadId ? activeSnippet : ''"
            :renaming="renamingId === t.id"
            :rename-draft="renameDraft"
            @select="onSelectThread"
            @start-rename="startRename"
            @commit-rename="commitRename"
            @cancel-rename="cancelRename"
            @update:rename-draft="renameDraft = $event"
            @set-rename-el="setRenameEl"
            @toggle-pin="onTogglePin"
            @delete="onDelete"
          />
        </template>
      </template>
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
