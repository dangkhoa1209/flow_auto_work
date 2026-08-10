<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
  stopBusy?: boolean;
}>();

const emit = defineEmits<{
  send: [content: string];
  stop: [];
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
  <div class="faw-console-input">
    <a-tooltip :title="disabled && disabledReason ? disabledReason : ''">
      <a-textarea
        v-model:value="text"
        :rows="2"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :disabled="disabled || loading"
        :placeholder="
          loading
            ? 'Đang suy nghĩ… đợi xong rồi hỏi tiếp'
            : 'Hỏi về dự án — nên kèm URL hoặc tên màn hình / nút trên UI'
        "
        @keydown="onKeydown"
      />
    </a-tooltip>
    <div class="faw-console-input__row faw-ba-input-row">
      <span class="faw-ba-input-hint">
        URL hoặc điểm neo UI · ⌘/Ctrl+Enter gửi
      </span>
      <div class="faw-ba-input-actions">
        <a-popconfirm
          v-if="loading"
          title="Dừng trả lời đang chạy?"
          ok-text="Dừng"
          cancel-text="Huỷ"
          ok-type="danger"
          @confirm="emit('stop')"
        >
          <button
            type="button"
            class="faw-btn faw-btn--danger"
            :disabled="stopBusy"
          >
            {{ stopBusy ? "…" : "Stop" }}
          </button>
        </a-popconfirm>
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
  </div>
</template>
