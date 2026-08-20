<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  dimensions: Record<string, number>;
  previous?: Record<string, number>;
}>();

const labels: { key: string; label: string; angle: number }[] = [
  { key: "speed", label: "Tốc độ", angle: -90 },
  { key: "accuracy", label: "Chính xác", angle: -18 },
  { key: "scope", label: "Phạm vi", angle: 54 },
  { key: "consistency", label: "Nhất quán", angle: 126 },
  { key: "efficiency", label: "Hiệu quả", angle: 198 },
];

const cx = 110;
const cy = 110;
const maxR = 72;

function point(angleDeg: number, value: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const r = (Math.max(0, Math.min(100, value)) / 100) * maxR;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

const gridLevels = [0.25, 0.5, 0.75, 1];

const valuePolygon = computed(() =>
  labels
    .map(({ key, angle }) => {
      const v = props.dimensions[key] ?? 0;
      const p = point(angle, v);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" "),
);

const baselinePolygon = computed(() => {
  if (!props.previous) return "";
  return labels
    .map(({ key, angle }) => {
      const v = props.previous![key] ?? 0;
      const p = point(angle, v);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" ");
});

function axisEnd(angle: number) {
  return point(angle, 100);
}

function labelPos(angle: number) {
  const p = point(angle, 118);
  return p;
}
</script>

<template>
  <svg viewBox="0 0 220 220" class="w-full max-w-[240px] mx-auto" aria-hidden="true">
    <g v-for="lv in gridLevels" :key="lv">
      <polygon
        :points="
          labels
            .map(({ angle }) => {
              const p = point(angle, lv * 100);
              return `${p.x},${p.y}`;
            })
            .join(' ')
        "
        fill="none"
        stroke="currentColor"
        class="text-line"
        stroke-width="0.5"
        opacity="0.6"
      />
    </g>
    <g v-for="{ angle, label } in labels" :key="label">
      <line
        :x1="cx"
        :y1="cy"
        :x2="axisEnd(angle).x"
        :y2="axisEnd(angle).y"
        stroke="currentColor"
        class="text-line"
        stroke-width="0.5"
        opacity="0.5"
      />
      <text
        :x="labelPos(angle).x"
        :y="labelPos(angle).y"
        text-anchor="middle"
        dominant-baseline="middle"
        class="fill-ink-muted text-[9px]"
      >
        {{ label }}
      </text>
    </g>
    <polygon
      v-if="baselinePolygon"
      :points="baselinePolygon"
      fill="rgb(var(--c-accent) / 0.08)"
      stroke="rgb(var(--c-accent) / 0.35)"
      stroke-width="1"
      stroke-dasharray="3 2"
    />
    <polygon
      :points="valuePolygon"
      fill="rgb(var(--c-accent) / 0.22)"
      stroke="rgb(var(--c-accent))"
      stroke-width="1.5"
    />
  </svg>
</template>
