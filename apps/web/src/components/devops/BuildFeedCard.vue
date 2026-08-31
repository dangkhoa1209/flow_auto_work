<script setup lang="ts">
import { computed } from "vue";
import { RightOutlined } from "@ant-design/icons-vue";
import type { BuildJob, BuildLogLine } from "@/api/devopsApi";
import BuildLogPane from "@/components/devops/BuildLogPane.vue";

const props = defineProps<{
  job: BuildJob;
  open: boolean;
  lines: BuildLogLine[];
  nowMs: number;
}>();

defineEmits<{
  toggle: [];
  download: [];
  copy: [];
  cancel: [];
}>();

const badge = computed(() => {
  const s = props.job.status;
  if (s === "running") return { label: "RUNNING", cls: "running" };
  if (s === "queued") return { label: "QUEUED", cls: "queued" };
  if (s === "success") return { label: "SUCCESS", cls: "success" };
  if (s === "failed" || s === "timeout")
    return { label: "FAILED", cls: "failed" };
  return { label: s.toUpperCase(), cls: "warn" };
});

const timeLabel = computed(() => {
  const j = props.job;
  if (j.status === "queued") return "waiting…";
  if (j.status === "running" && j.startedAt) {
    const t = Date.parse(j.startedAt);
    if (!Number.isFinite(t)) return "0:00";
    const s = Math.floor((props.nowMs - t) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  const ms = j.durationMs;
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
});
</script>

<template>
  <article class="faw-build-card" :class="{ 'is-open': open }">
    <header class="faw-build-card__head" @click="$emit('toggle')">
      <RightOutlined class="faw-build-card__chev" />
      <span v-if="job.status === 'running'" class="faw-build-card__pulse" />
      <span class="faw-build-card__badge" :class="`faw-build-card__badge--${badge.cls}`">
        {{ badge.label }}
      </span>
      <div class="faw-build-card__title-wrap">
        <div class="faw-build-card__title">{{ job.scriptLabel }}</div>
        <div class="faw-build-card__cmd">{{ job.command }}</div>
      </div>
      <span class="faw-build-card__time">{{ timeLabel }}</span>
    </header>
    <div v-show="open" class="faw-build-card__body">
      <BuildLogPane :lines="lines" :running="job.status === 'running'" />
      <p
        v-if="job.errorMessage"
        class="faw-build-card__err"
        role="alert"
      >
        {{ job.errorMessage }}
      </p>
      <footer class="faw-build-card__foot">
        <button type="button" class="faw-build-card__foot-btn" @click.stop="$emit('copy')">
          Copy command
        </button>
        <button type="button" class="faw-build-card__foot-btn" @click.stop="$emit('download')">
          Download log
        </button>
        <button
          v-if="job.status === 'running'"
          type="button"
          class="faw-build-card__foot-btn faw-build-card__foot-btn--danger"
          @click.stop="$emit('cancel')"
        >
          Cancel
        </button>
      </footer>
    </div>
  </article>
</template>
