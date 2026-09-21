<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  cells: { date: string; jobs: number; tokens: number }[];
}>();

const maxJobs = computed(() =>
  Math.max(1, ...props.cells.map((c) => c.jobs || 0)),
);

function level(cell: { jobs: number }): number {
  const v = cell.jobs;
  if (!v) return 0;
  const r = v / maxJobs.value;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

/** Columns = weeks (Mon–Sun rows), padded from first date. */
const columns = computed(() => {
  const cells = [...props.cells].sort((a, b) => a.date.localeCompare(b.date));
  if (!cells.length) return [];
  const byDate = new Map(cells.map((c) => [c.date, c]));
  const first = cells[0]!.date;
  const [Y, M, D] = first.split("-").map(Number);
  const start = new Date(Date.UTC(Y, M - 1, D));
  const weekday = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - (weekday - 1));

  const last = cells[cells.length - 1]!.date;
  const [ly, lm, ld] = last.split("-").map(Number);
  const end = new Date(Date.UTC(ly, lm - 1, ld));

  const cols: { date: string; cell: (typeof cells)[0] | null }[][] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const col: { date: string; cell: (typeof cells)[0] | null }[] = [];
    for (let i = 0; i < 7; i++) {
      const y = cursor.getUTCFullYear();
      const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
      const d = String(cursor.getUTCDate()).padStart(2, "0");
      const ymd = `${y}-${m}-${d}`;
      col.push({ date: ymd, cell: byDate.get(ymd) ?? null });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    cols.push(col);
  }
  return cols;
});
</script>

<template>
  <div class="overflow-x-auto">
    <div class="inline-flex gap-[3px]">
      <div
        v-for="(col, ci) in columns"
        :key="ci"
        class="flex flex-col gap-[3px]"
      >
        <div
          v-for="cell in col"
          :key="cell.date"
          class="h-[11px] w-[11px] rounded-[2px] faw-heat-cell"
          :class="`faw-heat-cell--${cell.cell ? level(cell.cell) : 0}`"
          :title="
            cell.cell
              ? `${cell.date} · ${cell.cell.jobs} task`
              : cell.date
          "
        />
      </div>
    </div>
    <div class="mt-1 flex items-center gap-1 text-[10px] text-ink-muted">
      Less
      <span class="inline-block h-[10px] w-[10px] rounded-[2px] faw-heat-cell faw-heat-cell--0" />
      <span class="inline-block h-[10px] w-[10px] rounded-[2px] faw-heat-cell faw-heat-cell--1" />
      <span class="inline-block h-[10px] w-[10px] rounded-[2px] faw-heat-cell faw-heat-cell--2" />
      <span class="inline-block h-[10px] w-[10px] rounded-[2px] faw-heat-cell faw-heat-cell--3" />
      <span class="inline-block h-[10px] w-[10px] rounded-[2px] faw-heat-cell faw-heat-cell--4" />
      More tasks
    </div>
  </div>
</template>

<style scoped>
.faw-heat-cell--0 {
  background: var(--hm-empty);
}
.faw-heat-cell--1 {
  background: var(--hm-1);
}
.faw-heat-cell--2 {
  background: var(--hm-2);
}
.faw-heat-cell--3 {
  background: var(--hm-3);
}
.faw-heat-cell--4 {
  background: var(--hm-4);
}
</style>
