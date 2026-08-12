<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
  stopBusy?: boolean;
  analysisMode?: boolean;
}>();

const emit = defineEmits<{
  send: [content: string];
  stop: [];
  "update:analysisMode": [boolean];
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
  if (e.key !== "Enter") return;
  if (e.isComposing) return;
  if (e.shiftKey) return; // Shift+Enter → newline
  e.preventDefault();
  submit();
}
</script>

<template>
  <div class="faw-console-input">
    <a-tooltip :title="disabled && disabledReason ? disabledReason : ''">
      <a-textarea
        v-model:value="text"
        :rows="2"
        :auto-size="{ minRows: 2, maxRows: 12 }"
        :disabled="disabled || loading"
        :placeholder="
          loading
            ? 'Đang suy nghĩ… đợi xong rồi hỏi tiếp'
            : analysisMode
              ? 'Mô tả yêu cầu / bài toán cần BA phân tích (kèm URL hoặc màn hình nếu có)…'
              : 'Hỏi về dự án — nên kèm URL hoặc tên màn hình / nút trên UI'
        "
        @keydown="onKeydown"
      />
    </a-tooltip>
    <div class="faw-console-input__row faw-ba-input-row">
      <div class="faw-ba-input-hint flex items-center gap-2 flex-wrap min-w-0">
        <a-tooltip
          title="Bật: agent đóng vai BA phân tích nghiệp vụ (bám UI thật, quyết định rõ). Tắt: hỏi đáp sản phẩm thường."
        >
          <label
            class="inline-flex items-center gap-1.5 cursor-pointer select-none shrink-0 text-[11px] text-[var(--app-muted)]"
          >
            <a-switch
              size="small"
              :checked="analysisMode"
              :disabled="loading"
              @change="(v: boolean) => emit('update:analysisMode', v)"
            />
            <span
              :class="
                analysisMode
                  ? 'text-[var(--app-ink)] font-medium'
                  : undefined
              "
              >BA mode</span
            >
          </label>
        </a-tooltip>
        <span class="opacity-70">Enter gửi · Shift+Enter xuống dòng</span>
      </div>
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
