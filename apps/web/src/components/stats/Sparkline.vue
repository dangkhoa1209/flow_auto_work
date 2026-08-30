<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    values?: number[];
    width?: number;
    height?: number;
  }>(),
  { values: () => [] as number[], width: 96, height: 28 },
);

const points = computed(() => {
  const vals = props.values || [];
  if (!vals.length) return "";
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const span = Math.max(max - min, 1);
  const n = vals.length;
  return vals
    .map((v, i) => {
      const x = n === 1 ? props.width / 2 : (i / (n - 1)) * props.width;
      const y = props.height - ((v - min) / span) * (props.height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
});

/** Single-day / empty-ish series — show a dot so it is not blank. */
const loneDot = computed(() => {
  const vals = props.values || [];
  if (vals.length !== 1) return null;
  const max = Math.max(vals[0]!, 1);
  const y = props.height - (vals[0]! / max) * (props.height - 2) - 1;
  return { x: props.width / 2, y };
});
</script>

<template>
  <svg
    :width="width"
    :height="height"
    class="inline-block align-middle text-accent"
    aria-hidden="true"
  >
    <polyline
      v-if="values.length >= 2"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
      :points="points"
    />
    <circle
      v-else-if="loneDot"
      :cx="loneDot.x"
      :cy="loneDot.y"
      r="2.5"
      fill="currentColor"
    />
  </svg>
</template>
