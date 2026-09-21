<script setup lang="ts">
import { computed, ref, useSlots } from "vue";
import { message } from "ant-design-vue";
import { CopyOutlined, FileMarkdownOutlined } from "@ant-design/icons-vue";
import { renderChatHtml, cleanMarkdownBody } from "@/utils/chatFormat";

const props = withDefaults(
  defineProps<{
    body: string;
    role?: string;
    /** Always render markdown (issue description / comments). */
    markdown?: boolean;
    /** GitLab issue URL — resolve /uploads/ images. */
    issueUrl?: string | null;
    empty?: string;
    /** Show Copy MD / Copy text actions (chat messages). */
    copyable?: boolean;
  }>(),
  {
    role: "agent",
    markdown: undefined,
    issueUrl: null,
    empty: "",
    copyable: false,
  },
);

const slots = useSlots();
const bodyEl = ref<HTMLElement | null>(null);

const useMarkdown = computed(() => {
  if (props.markdown != null) return props.markdown;
  return props.role !== "user";
});

const html = computed(() => {
  const raw = props.body?.trim() || props.empty || "";
  if (!raw) return "";
  return renderChatHtml(raw, {
    markdown: useMarkdown.value,
    issueUrl: props.issueUrl,
  });
});

const mdSource = computed(() => {
  const raw = props.body?.trim() || "";
  if (!raw) return "";
  // No issueUrl → keep original /uploads/ paths (no API proxy + token in clipboard).
  return cleanMarkdownBody(raw);
});

const showFoot = computed(() => props.copyable || !!slots.meta);

async function writeClipboard(text: string, ok: string) {
  const t = text?.trim();
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    message.success(ok);
  } catch {
    message.error("Could not copy");
  }
}

async function copyMd() {
  await writeClipboard(mdSource.value, "Markdown copied");
}

async function copyText() {
  const fromDom = bodyEl.value?.innerText?.trim() || "";
  const fallback = mdSource.value;
  await writeClipboard(fromDom || fallback, "Text copied");
}
</script>

<template>
  <div v-if="html" class="chat-md-wrap">
    <div
      ref="bodyEl"
      class="chat-md"
      :class="useMarkdown ? 'chat-md-rich' : 'chat-md-user'"
      v-html="html"
    />
    <slot name="below" />
    <div v-if="showFoot" class="chat-md-foot">
      <div v-if="copyable" class="chat-md-copy">
        <button
          type="button"
          class="chat-md-copy__btn"
          title="Copy as Markdown"
          aria-label="Copy as Markdown"
          @click.stop="copyMd"
        >
          <FileMarkdownOutlined />
        </button>
        <button
          type="button"
          class="chat-md-copy__btn"
          title="Copy as plain text"
          aria-label="Copy as plain text"
          @click.stop="copyText"
        >
          <CopyOutlined />
        </button>
      </div>
      <div v-else class="chat-md-foot__spacer" aria-hidden="true" />
      <div class="chat-md-foot__meta">
        <slot name="meta" />
      </div>
    </div>
  </div>
  <div v-else class="text-ink-faint text-[12px]">{{ empty || "—" }}</div>
</template>

<style scoped>
.chat-md-foot {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px 8px;
  margin-top: 6px;
  min-height: 18px;
  width: 100%;
  justify-content: space-between;
}
.chat-md-foot__spacer {
  flex: 1 1 auto;
  min-width: 0;
}
.chat-md-foot__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-left: auto;
}
.chat-md-foot__meta :deep(.faw-msg__time) {
  margin-top: 0;
  text-align: right;
}
.chat-md-copy {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.chat-md-copy__btn {
  appearance: none;
  border: 1px solid var(--app-border);
  background: var(--app-panel, transparent);
  color: var(--app-faint);
  font-size: 11px;
  line-height: 1;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.chat-md-copy__btn:hover {
  color: var(--app-accent);
  border-color: var(--app-accent);
}
.chat-md-copy__btn:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}
.faw-msg.user .chat-md-copy__btn {
  background: rgb(255 255 255 / 0.35);
}
</style>
