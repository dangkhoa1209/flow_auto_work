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
  if (e.key !== "Enter") return;
  if (e.isComposing) return;
  if (e.shiftKey) return;
  if (props.disabled || props.stopBusy) return;
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
        :disabled="Boolean(disabled)"
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
            class="inline-flex items-center gap-1.5 cursor-pointer select-none shrink-0 text-[11px] text-[var(--app-muted)]"
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
        <span class="opacity-70">Enter to send · Shift+Enter for newline</span>
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
          Send
        </button>
      </div>
    </div>
  </div>
</template>
