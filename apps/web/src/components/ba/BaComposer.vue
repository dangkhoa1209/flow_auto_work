<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Modal } from "ant-design-vue";

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
const inputWrap = ref<HTMLElement | null>(null);
const focused = ref(false);

/** Draft anytime; project gates use `disabled`. Streaming still allows Send (confirm). */
const canSend = computed(
  () => Boolean(text.value.trim()) && !props.disabled && !props.stopBusy,
);

async function doSend(content: string) {
  text.value = "";
  await nextTick();
  emit("send", content);
}

function submit() {
  if (!canSend.value) return;
  const content = text.value.trim();
  if (!content) return;

  if (props.loading) {
    Modal.confirm({
      title: "Stop the current reply?",
      content:
        "Sending will stop the running answer and start your new message.",
      okText: "Stop & send",
      cancelText: "Keep running",
      okType: "danger",
      centered: true,
      onOk: () => doSend(content),
    });
    return;
  }

  void doSend(content);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.loading && !props.stopBusy) {
    e.preventDefault();
    emit("stop");
    return;
  }
  if (e.key !== "Enter") return;
  if (e.isComposing) return;
  // Ctrl/Cmd+Enter always sends; plain Enter sends unless Shift (newline).
  if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
  if (props.disabled || props.stopBusy) return;
  e.preventDefault();
  submit();
}

function focusInput() {
  const el = inputWrap.value?.querySelector?.("textarea");
  el?.focus();
}

/** Fill composer from empty-state tips / external prompts. */
function fill(prompt: string) {
  text.value = prompt;
  void nextTick(() => focusInput());
}

defineExpose({ fill, focusInput });
</script>

<template>
  <div
    ref="inputWrap"
    class="faw-console-input faw-ba-composer"
    :class="{ 'faw-ba-composer--focused': focused }"
    role="form"
    aria-label="Message composer"
  >
    <div class="faw-ba-composer__card">
      <a-tooltip :title="disabled && disabledReason ? disabledReason : ''">
        <a-textarea
          v-model:value="text"
          :rows="2"
          :auto-size="{ minRows: 2, maxRows: 12 }"
          :disabled="Boolean(disabled)"
          aria-label="Chat message"
          :placeholder="
            loading
              ? 'Follow-up… Send stops current reply'
              : analysisMode
                ? 'Ask or request BA analysis…'
                : 'Ask about the product…'
          "
          @keydown="onKeydown"
          @focus="focused = true"
          @blur="focused = false"
        />
      </a-tooltip>
      <div class="faw-console-input__row faw-ba-input-row">
        <div
          class="faw-ba-input-hint flex items-center gap-2 flex-wrap min-w-0"
          :class="{ 'faw-ba-input-hint--visible': focused }"
        >
          <span class="faw-ba-input-hint--desktop opacity-70"
            >Enter send · Shift+Enter newline · Esc stop</span
          >
          <span class="faw-ba-input-hint--mobile opacity-70"
            >Enter send · Esc stop</span
          >
        </div>
        <div class="faw-ba-input-actions">
          <a-tooltip
            title="On: ready for BA analysis when you ask; normal Q&A still works. Off: product Q&A only."
          >
            <label
              class="faw-ba-mode-chip"
              :class="{ 'faw-ba-mode-chip--on': analysisMode }"
            >
              <a-switch
                size="small"
                :checked="analysisMode"
                :disabled="disabled"
                @change="(v: boolean) => emit('update:analysisMode', v)"
              />
              <span>BA</span>
            </label>
          </a-tooltip>
          <a-popconfirm
            v-if="loading"
            title="Stop the running reply?"
            ok-text="Stop"
            cancel-text="Cancel"
            ok-type="danger"
            @confirm="emit('stop')"
          >
            <button
              type="button"
              class="faw-btn faw-btn--danger"
              :disabled="stopBusy"
              aria-label="Stop reply"
            >
              {{ stopBusy ? "…" : "Stop" }}
            </button>
          </a-popconfirm>
          <button
            type="button"
            class="faw-btn faw-btn--run faw-btn--send"
            :disabled="!canSend"
            aria-label="Send message"
            @click="submit"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
