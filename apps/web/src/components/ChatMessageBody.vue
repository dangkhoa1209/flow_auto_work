<script setup lang="ts">
import { computed, ref, useSlots } from "vue";
import { message } from "ant-design-vue";
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
    <div v-if="showFoot" class="chat-md-foot">
      <div class="chat-md-foot__meta">
        <slot name="meta" />
      </div>
      <div v-if="copyable" class="chat-md-copy">
        <button
          type="button"
          class="chat-md-copy__btn"
          title="Copy as Markdown"
          @click.stop="copyMd"
        >
          Copy MD
        </button>
        <button
          type="button"
          class="chat-md-copy__btn"
          title="Copy as plain text"
          @click.stop="copyText"
        >
          Copy text
        </button>
      </div>
    </div>
  </div>
  <div v-else class="text-ink-faint text-sm">{{ empty || "—" }}</div>
</template>

<style scoped>
.chat-md-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin-top: 6px;
  min-height: 18px;
}
.chat-md-foot__meta {
  display: flex;
  align-items: center;
  min-width: 0;
}
.chat-md-foot__meta :deep(.faw-msg__time) {
  margin-top: 0;
}
.chat-md-copy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.faw-msg.user .chat-md-foot {
  justify-content: flex-end;
}
.chat-md-copy__btn {
  appearance: none;
  border: 1px solid var(--app-border);
  background: var(--app-panel, transparent);
  color: var(--app-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 4px;
  cursor: pointer;
}
.chat-md-copy__btn:hover {
  color: var(--app-accent);
  border-color: var(--app-accent);
}
.faw-msg.user .chat-md-copy__btn {
  background: rgb(255 255 255 / 0.35);
}
</style>
