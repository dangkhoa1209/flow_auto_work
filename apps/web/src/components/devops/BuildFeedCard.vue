<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RightOutlined } from "@ant-design/icons-vue";
import type { BuildJob, BuildLogLine } from "@/api/devopsApi";
import BuildLogPane from "@/components/devops/BuildLogPane.vue";
import { formatBuildDurationMs } from "@/utils/formatBuildDuration";
import { formatRelativeTime } from "@/utils/formatChatTime";

const TERMINAL = new Set([
  "success",
  "failed",
  "cancelled",
  "timeout",
]);

const props = defineProps<{
  job: BuildJob;
  open: boolean;
  lines: BuildLogLine[];
  nowMs: number;
  flash?: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  download: [];
  copy: [];
  cancel: [];
  rerun: [];
  "open-terminal": [];
  "copy-log": [text: string];
}>();

const errorsOnly = ref(false);
const logExpanded = ref(false);
const logPane = ref<{
  jumpToBottom: () => Promise<void>;
  copyVisible: () => string;
} | null>(null);

const badge = computed(() => {
  const s = props.job.status;
  if (s === "running") return { label: "RUNNING", cls: "running" };
  if (s === "queued") return { label: "QUEUED", cls: "queued" };
  if (s === "success") return { label: "SUCCESS", cls: "success" };
  if (s === "failed" || s === "timeout")
    return { label: "FAILED", cls: "failed" };
  return { label: s.toUpperCase(), cls: "warn" };
});

const durationLabel = computed(() => {
  const j = props.job;
  if (j.status === "queued") return "waiting…";
  if (j.status === "running" && j.startedAt) {
    const t = Date.parse(j.startedAt);
    if (!Number.isFinite(t)) return "0s";
    return formatBuildDurationMs(props.nowMs - t);
  }
  const ms = j.durationMs;
  if (ms == null) return "—";
  return formatBuildDurationMs(ms);
});

const startIso = computed(
  () => props.job.startedAt || props.job.queuedAt || props.job.createdAt,
);

const metaLine = computed(() => {
  void props.nowMs;
  const who = props.job.triggeredBy?.trim()
    ? `@${props.job.triggeredBy.trim()}`
    : "";
  const when = formatRelativeTime(startIso.value) || "";
  const bits = [who, when].filter(Boolean);
  return bits.join(" · ");
});

const warningText = computed(() => props.job.warningMessage?.trim() || "");

const canRerun = computed(() => TERMINAL.has(props.job.status));

const isRunning = computed(() => props.job.status === "running");

watch(
  () => props.open,
  (open) => {
    if (!open) {
      errorsOnly.value = false;
      logExpanded.value = false;
    }
  },
);

function onCopyVisible() {
  const text = logPane.value?.copyVisible?.() || "";
  emit("copy-log", text);
}
</script>

<template>
  <article
    class="faw-build-card"
    :class="{
      'is-open': open,
      'is-flash': flash,
      'is-running': isRunning,
    }"
    :aria-busy="isRunning ? 'true' : undefined"
  >
    <header
      class="faw-build-card__head"
      tabindex="0"
      role="button"
      :aria-expanded="open"
      @click="$emit('toggle')"
      @keydown.enter.prevent="$emit('toggle')"
      @keydown.space.prevent="$emit('toggle')"
    >
      <RightOutlined class="faw-build-card__chev" />
      <span v-if="isRunning" class="faw-build-card__pulse" aria-hidden="true" />
      <span
        class="faw-build-card__badge"
        :class="`faw-build-card__badge--${badge.cls}`"
      >
        {{ badge.label }}
      </span>
      <div class="faw-build-card__title-wrap">
        <div class="faw-build-card__title">{{ job.scriptLabel }}</div>
        <div class="faw-build-card__cmd">{{ job.command }}</div>
        <div v-if="metaLine" class="faw-build-card__meta">{{ metaLine }}</div>
      </div>
      <span class="faw-build-card__time" :title="startIso">{{
        durationLabel
      }}</span>
    </header>
    <div v-show="open" class="faw-build-card__body">
      <pre
        v-if="warningText"
        class="faw-build-card__warn"
        role="status"
      >{{ warningText }}</pre>
      <div class="faw-build-card__log-tools">
        <button
          type="button"
          class="faw-build-card__tool"
          :class="{ 'is-on': errorsOnly }"
          :aria-pressed="errorsOnly"
          @click.stop="errorsOnly = !errorsOnly"
        >
          Errors only
        </button>
        <button
          type="button"
          class="faw-build-card__tool"
          :class="{ 'is-on': logExpanded }"
          :aria-pressed="logExpanded"
          @click.stop="logExpanded = !logExpanded"
        >
          {{ logExpanded ? "Collapse log" : "Expand log" }}
        </button>
        <button
          type="button"
          class="faw-build-card__tool"
          @click.stop="onCopyVisible"
        >
          Copy visible
        </button>
      </div>
      <BuildLogPane
        ref="logPane"
        :lines="lines"
        :running="isRunning"
        :errors-only="errorsOnly"
        :expanded="logExpanded"
        v-memo="[
          lines.length,
          lines.at(-1)?.text,
          isRunning,
          errorsOnly,
          logExpanded,
        ]"
      />
      <p
        v-if="job.errorMessage"
        class="faw-build-card__err"
        role="alert"
      >
        {{ job.errorMessage }}
      </p>
      <footer class="faw-build-card__foot">
        <button
          type="button"
          class="faw-build-card__foot-btn"
          @click.stop="$emit('copy')"
        >
          Copy command
        </button>
        <button
          type="button"
          class="faw-build-card__foot-btn"
          @click.stop="$emit('download')"
        >
          Download log
        </button>
        <button
          type="button"
          class="faw-build-card__foot-btn"
          @click.stop="$emit('open-terminal')"
        >
          Open in terminal
        </button>
        <button
          v-if="canRerun"
          type="button"
          class="faw-build-card__foot-btn faw-build-card__foot-btn--run"
          @click.stop="$emit('rerun')"
        >
          Re-run
        </button>
        <button
          v-if="isRunning"
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
