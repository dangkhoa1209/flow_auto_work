<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Modal } from "ant-design-vue";

const props = defineProps<{
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
  stopBusy?: boolean;
  sendBusy?: boolean;
  analysisMode?: boolean;
}>();

const emit = defineEmits<{
  send: [content: string];
  stop: [];
  "update:analysisMode": [boolean];
}>();

const text = ref("");
const inputWrap = ref<HTMLElement | null>(null);

/** Draft anytime; project gates use `disabled`. Streaming still allows Send (confirm). */
const canSend = computed(() => {
  if (!text.value.trim() || props.disabled || props.stopBusy) return false;
  if (props.loading) return true;
  return !props.sendBusy;
});

function emitSend(content: string) {
  text.value = "";
  emit("send", content);
  void nextTick(() => focusInput());
}

function submit() {
  if (props.disabled || props.stopBusy) return;
  const content = text.value.trim();
  if (!content) return;
  if (!props.loading && props.sendBusy) return;

  if (props.loading) {
    Modal.confirm({
      title: "Stop the current reply?",
      content:
        "Sending will stop the running answer and start your new message.",
      okText: "Stop & send",
      cancelText: "Keep running",
      okType: "danger",
      centered: true,
      onOk: () => emitSend(content),
    });
    return;
  }

  emitSend(content);
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
  if (props.disabled || props.stopBusy || props.sendBusy) return;
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
    role="form"
    aria-label="Message composer"
  >
    <a-tooltip :title="disabled && disabledReason ? disabledReason : ''">
      <a-textarea
        v-model:value="text"
        :rows="2"
        :auto-size="{ minRows: 2, maxRows: 12 }"
        :disabled="Boolean(disabled)"
        aria-label="Chat message"
        :placeholder="
          loading
            ? 'Type a follow-up — Send will ask to stop the current reply…'
            : analysisMode
              ? 'Ask normally or request BA analysis / specs (include requirements, issue links, docs…)…'
              : 'Ask about the product — include a URL or screen / button name when you can'
        "
        @keydown="onKeydown"
      />
    </a-tooltip>
    <div class="faw-console-input__row faw-ba-input-row">
      <div class="faw-ba-input-hint flex items-center gap-2 flex-wrap min-w-0">
        <a-tooltip
          title="On: ready for BA analysis when you ask for it; normal Q&A still works. Off: product Q&A only."
        >
          <label
            class="faw-ba-mode-toggle inline-flex items-center gap-1.5 cursor-pointer select-none shrink-0 text-[11px] text-[var(--app-muted)]"
          >
            <a-switch
              size="small"
              :checked="analysisMode"
              :disabled="disabled"
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
        <span class="faw-ba-input-hint--desktop opacity-70"
          >Enter / ⌘·Ctrl+Enter send · Shift+Enter newline · Esc stop</span
        >
        <span class="faw-ba-input-hint--mobile opacity-70"
          >Enter send · Esc stop</span
        >
      </div>
      <div class="faw-ba-input-actions">
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
          {{ sendBusy && !loading ? "Sending…" : "Send" }}
        </button>
      </div>
    </div>
  </div>
</template>
