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
      <div class="ba-composer">
        <a-textarea
          v-model:value="text"
          :rows="3"
          :disabled="disabled || loading"
          :auto-size="{ minRows: 2, maxRows: 6 }"
          placeholder="Hỏi về dự án… Nên kèm URL hoặc tên màn hình / nút trên UI. ⌘/Ctrl+Enter để gửi"
          class="ba-composer__input"
          @keydown="onKeydown"
        />
        <div class="ba-composer__row">
          <span class="ba-composer__hint text-xs text-ink-muted">
            Nên nêu URL hoặc điểm neo UI (menu, nút, màn hình)
          </span>
          <button
            type="button"
            class="faw-btn faw-btn--run faw-btn--send"
            :disabled="!canSend"
            @click="submit"
          >
            {{ loading ? "…" : "Send" }}
          </button>
        </div>
      </div>
    </a-tooltip>
  </div>
</template>

<style scoped>
.ba-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.ba-composer__input {
  width: 100% !important;
}
.ba-composer__input :deep(textarea) {
  width: 100% !important;
  resize: none;
}
.ba-composer__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ba-composer__hint {
  flex: 1;
  min-width: 0;
  line-height: 1.35;
}
</style>
