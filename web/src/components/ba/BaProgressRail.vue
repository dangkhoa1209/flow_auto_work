<script setup lang="ts">
import { computed } from "vue";
import { useBaChatStore, type BaProgressStep } from "@/stores/baChat";

const ba = useBaChatStore();

const STEPS: Array<{ id: BaProgressStep; short: string }> = [
  { id: "pull", short: "Đồng bộ" },
  { id: "start", short: "Khởi động" },
  { id: "read", short: "Đọc UI" },
  { id: "write", short: "Soạn trả lời" },
  { id: "done", short: "Xong" },
];

const activeStep = computed(
  () => ba.progress[ba.progress.length - 1]?.step || null,
);

const isError = computed(() => activeStep.value === "error");

function stepState(id: BaProgressStep): "done" | "active" | "todo" {
  const cur = activeStep.value;
  if (!cur || cur === "error") {
    if (cur === "error") return "todo";
    return "todo";
  }
  const order = STEPS.map((s) => s.id);
  const ci = order.indexOf(cur);
  const ii = order.indexOf(id);
  if (ii < 0) return "todo";
  if (ii < ci) return "done";
  if (ii === ci) return "active";
  return "todo";
}
</script>

<template>
  <div
    v-if="ba.progressVisible && (ba.streaming || ba.progress.length)"
    class="faw-ba-progress"
    :class="{ 'is-error': isError }"
  >
    <div class="faw-ba-progress__bar">
      <div
        class="faw-ba-progress__fill"
        :style="{ width: `${ba.progressPct}%` }"
      />
    </div>
    <div class="faw-ba-progress__row">
      <div class="faw-ba-progress__live">
        <span class="chat-typing" aria-hidden="true">
          <span /><span /><span />
        </span>
        <span class="faw-ba-progress__label">{{
          ba.currentProgressLabel || "Đang xử lý…"
        }}</span>
        <span
          v-if="ba.progress[ba.progress.length - 1]?.detail"
          class="faw-ba-progress__detail"
        >
          · {{ ba.progress[ba.progress.length - 1]?.detail }}
        </span>
      </div>
      <div class="faw-ba-progress__steps" aria-hidden="true">
        <span
          v-for="s in STEPS"
          :key="s.id"
          class="faw-ba-progress__chip"
          :class="`is-${stepState(s.id)}`"
          :title="s.short"
        >
          {{ s.short }}
        </span>
      </div>
    </div>
  </div>
</template>
