<script setup lang="ts">
import { computed } from "vue";
import { renderChatHtml } from "@/utils/chatFormat";

const props = withDefaults(
  defineProps<{
    body: string;
    role?: string;
    /** Always render markdown (issue description / comments). */
    markdown?: boolean;
    /** GitLab issue URL — resolve /uploads/ images. */
    issueUrl?: string | null;
    empty?: string;
  }>(),
  {
    role: "agent",
    markdown: undefined,
    issueUrl: null,
    empty: "",
  },
);

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
</script>

<template>
  <div
    v-if="html"
    class="chat-md"
    :class="useMarkdown ? 'chat-md-rich' : 'chat-md-user'"
    v-html="html"
  />
  <div v-else class="text-ink-faint text-sm">{{ empty || "—" }}</div>
</template>
