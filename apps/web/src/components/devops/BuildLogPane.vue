<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { BuildLogLine } from "@/api/devopsApi";
import { useAutoScroll } from "@/composables/useAutoScroll";

const RSYNC_ERROR_RE = /rsync\s+error/i;
const ERROR_KIND = new Set(["err", "warn"]);

const props = defineProps<{
  lines: BuildLogLine[];
  running?: boolean;
  /** Show only stderr / warn / fail-ish lines. */
  errorsOnly?: boolean;
  /** Expand max-height for denser reading. */
  expanded?: boolean;
}>();

const emit = defineEmits<{
  "jump-visible": [visible: boolean];
}>();

const rows = computed(() => {
  const mapped = props.lines.map((line) => {
    let kind = "out";
    if (line.stream === "system") kind = "meta";
    else if (line.stream === "stderr") kind = "err";
    else if (/finished status=success/i.test(line.text)) kind = "ok";
    else if (/^started command:/i.test(line.text)) kind = "cmd";
    if (RSYNC_ERROR_RE.test(line.text)) kind = "warn";
    return { kind, text: line.text };
  });
  if (!props.errorsOnly) return mapped;
  return mapped.filter((r) => ERROR_KIND.has(r.kind));
});

const visibleText = computed(() =>
  rows.value.map((r) => r.text).join("\n"),
);

const logRef = ref<HTMLElement | null>(null);
const { pinnedToBottom, onScroll, onWheel, onTouchMove, jumpToBottom, resetPin } =
  useAutoScroll(logRef, () =>
    [rows.value.length, props.running ? "r" : "", props.lines.at(-1)?.text || ""].join(
      "|",
    ),
  );

const showJump = computed(
  () => !pinnedToBottom.value && (rows.value.length > 0 || !!props.running),
);

watch(
  () => props.expanded,
  async (expanded, prev) => {
    if (expanded === prev) return;
    if (expanded && pinnedToBottom.value) {
      await jumpToBottom();
    }
  },
);

watch(
  showJump,
  (v) => emit("jump-visible", v),
  { immediate: true },
);

watch(
  () => props.lines.length === 0,
  (empty) => {
    if (empty) resetPin();
  },
);

defineExpose({
  jumpToBottom,
  visibleText,
  copyVisible() {
    return visibleText.value;
  },
});
</script>

<template>
  <div class="faw-build-log-wrap">
    <div
      ref="logRef"
      class="faw-build-log"
      :class="{ 'is-expanded': expanded }"
      role="log"
      aria-relevant="additions"
      :aria-busy="running ? 'true' : undefined"
      :aria-live="running ? 'polite' : 'off'"
      @scroll="onScroll"
      @wheel.passive="onWheel"
      @touchmove.passive="onTouchMove"
    >
      <div v-if="!rows.length && !running" class="faw-build-log__empty">
        {{ errorsOnly ? "No error lines in this log." : "waiting in queue…" }}
      </div>
      <div
        v-for="(row, i) in rows"
        :key="i"
        class="faw-build-log__line"
        :class="`faw-build-log__line--${row.kind}`"
      >
        {{ row.text }}
      </div>
      <span
        v-if="running"
        class="faw-build-log__caret"
        aria-hidden="true"
      />
    </div>
    <button
      v-if="showJump"
      type="button"
      class="faw-build-jump"
      aria-label="Jump to latest log"
      @click="jumpToBottom()"
    >
      Jump to latest
    </button>
  </div>
</template>
