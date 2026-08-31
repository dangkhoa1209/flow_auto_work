<script setup lang="ts">
import { computed } from "vue";
import type { BuildLogLine } from "@/api/devopsApi";

const props = defineProps<{
  lines: BuildLogLine[];
  running?: boolean;
}>();

const rows = computed(() =>
  props.lines.map((line) => {
    let kind = "out";
    if (line.stream === "system") kind = "meta";
    else if (line.stream === "stderr") kind = "err";
    else if (/finished status=success/i.test(line.text)) kind = "ok";
    else if (/^started command:/i.test(line.text)) kind = "cmd";
    return { kind, text: line.text };
  }),
);
</script>

<template>
  <div class="faw-build-log">
    <div v-if="!rows.length && !running" class="faw-build-log__empty">
      đang chờ trong hàng đợi…
    </div>
    <div
      v-for="(row, i) in rows"
      :key="i"
      class="faw-build-log__line"
      :class="`faw-build-log__line--${row.kind}`"
    >
      {{ row.text }}
    </div>
    <span v-if="running" class="faw-build-log__caret" aria-hidden="true" />
  </div>
</template>
