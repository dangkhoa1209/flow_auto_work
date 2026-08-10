<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  send: [content: string];
}>();

const text = ref("");

const canSend = computed(
  () => Boolean(text.value.trim()) && !props.disabled && !props.loading,
);

function submit() {
  if (!canSend.value) return;
  const content = text.value;
  text.value = "";
  emit("send", content);
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="shrink-0 border-t border-line p-3 bg-surface-raised">
    <a-tooltip :title="disabled && disabledReason ? disabledReason : ''">
      <div class="flex gap-2 items-end">
        <a-textarea
          v-model:value="text"
          :rows="2"
          :disabled="disabled || loading"
          placeholder="Hỏi về dự án… (⌘/Ctrl+Enter để gửi)"
          class="flex-1"
          @keydown="onKeydown"
        />
        <button
          type="button"
          class="faw-btn faw-btn--run shrink-0"
          :disabled="!canSend"
          @click="submit"
        >
          {{ loading ? "…" : "Send" }}
        </button>
      </div>
    </a-tooltip>
  </div>
</template>
