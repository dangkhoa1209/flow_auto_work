<script setup lang="ts">
import { computed, useId } from "vue";

const props = withDefaults(
  defineProps<{
    variant?: "full" | "compact" | "mark";
    alt?: string;
    width?: number | string;
    height?: number | string;
  }>(),
  {
    variant: "full",
  },
);

const gradId = `brand-grad-${useId().replace(/:/g, "")}`;

const resolvedAlt = computed(
  () =>
    props.alt ??
    (props.variant === "mark" ? "FLOW.AUTO" : "Flow Auto WorkBench"),
);

const viewBox = computed(() => {
  if (props.variant === "mark") return "0 0 48 48";
  if (props.variant === "compact") return "0 0 168 36";
  return "0 0 248 56";
});

const defaultSize = computed(() => {
  if (props.variant === "mark") return { w: 28, h: 28 };
  if (props.variant === "compact") return { w: 132, h: 30 };
  return { w: 148, h: 33 };
});

const svgWidth = computed(() => props.width ?? defaultSize.value.w);
const svgHeight = computed(() => props.height ?? defaultSize.value.h);

const markTransform = computed(() => {
  if (props.variant === "mark") return "translate(2, 2)";
  if (props.variant === "compact") return "translate(4, 2)";
  return "translate(4, 6)";
});

const wordmarkY = computed(() => (props.variant === "compact" ? 24 : 30));
const wordmarkX = computed(() => (props.variant === "compact" ? 58 : 62));
</script>

<template>
  <svg
    :class="['faw-brand-svg', `faw-brand-svg--${variant}`]"
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="viewBox"
    fill="none"
    role="img"
    :aria-label="resolvedAlt"
    :width="svgWidth"
    :height="svgHeight"
  >
    <defs>
      <linearGradient :id="gradId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" class="faw-brand-svg__grad-start" />
        <stop offset="100%" class="faw-brand-svg__grad-end" />
      </linearGradient>
    </defs>

    <g :transform="markTransform" class="faw-brand-svg__mark">
      <path
        d="M10 8 H32 C38 8 42 12.5 42 18.5 C42 24.5 38 29 32 29 H18 V42"
        :stroke="`url(#${gradId})`"
        stroke-width="4.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M18 18.5 H30"
        :stroke="`url(#${gradId})`"
        stroke-width="4.5"
        stroke-linecap="round"
      />
      <circle cx="10" cy="8" r="3.5" class="faw-brand-svg__node-start" />
      <circle cx="42" cy="18.5" r="3.5" class="faw-brand-svg__node-mid" />
      <circle cx="18" cy="42" r="3.5" class="faw-brand-svg__node-done" />
    </g>

    <template v-if="variant !== 'mark'">
      <text
        :x="wordmarkX"
        :y="wordmarkY"
        class="faw-brand-svg__wordmark"
      >
        FLOW<tspan class="faw-brand-svg__accent">.AUTO</tspan>
      </text>
      <text
        v-if="variant === 'full'"
        x="62"
        y="47"
        class="faw-brand-svg__subtitle"
      >
        WORKBENCH
      </text>
    </template>
  </svg>
</template>
