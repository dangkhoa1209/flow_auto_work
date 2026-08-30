<script setup lang="ts">
import { computed } from "vue";
import IssueIidLink from "@/components/IssueIidLink.vue";
import DevRadar from "@/components/stats/DevRadar.vue";

export type DevAnalysis = {
  analyzedAt: string;
  from: string;
  to: string;
  jobCount: number;
  cached: boolean;
  truncated?: boolean;
  dimensions: Record<string, number>;
  previousDimensions?: Record<string, number>;
  trend?: Record<string, number | null>;
  byTaskType?: Array<{
    label: string;
    count: number;
    failRate: number | null;
    succeeded: number;
    failed: number;
  }>;
  recommendations: Array<{
    id: string;
    dimension: string;
    severity: string;
    text: string;
    evidenceJobs: Array<{
      jobId: string;
      issueIid: number;
      title: string;
      url: string;
    }>;
  }>;
  narrative?: string;
  engine?: string;
  dataGaps?: string[];
};

const props = defineProps<{
  analysis: DevAnalysis | null;
}>();

const emit = defineEmits<{
  highlightJobs: [jobIds: string[]];
}>();

const dimRows = computed(() => {
  const d = props.analysis?.dimensions;
  if (!d) return [];
  const labels: Record<string, string> = {
    speed: "Tốc độ",
    accuracy: "Chính xác",
    scope: "Phạm vi",
    consistency: "Nhất quán",
    efficiency: "Hiệu quả",
  };
  return Object.keys(labels).map((key) => ({
    key,
    label: labels[key]!,
    value: d[key] ?? 0,
    trend: props.analysis?.trend?.[key] ?? null,
  }));
});

function trendClass(n: number | null | undefined): string {
  if (n == null || n === 0) return "text-ink-muted";
  return n > 0 ? "text-status-done" : "text-red-500";
}

function fmtTrend(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}`;
}

function analyzedLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function onRecClick(rec: DevAnalysis["recommendations"][0]) {
  const ids = rec.evidenceJobs.map((j) => j.jobId).filter(Boolean);
  if (ids.length) emit("highlightJobs", ids);
}
</script>

<template>
  <div
    v-if="analysis"
    class="rounded-xl border border-line bg-surface-raised/30 p-4 space-y-4"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div class="text-sm font-medium text-ink">Đánh giá dev</div>
        <div class="text-[11px] text-ink-muted">
          {{ analysis.jobCount }} task · {{ analysis.from }} → {{ analysis.to }}
          <span v-if="analysis.engine"> · Agent</span>
          <span v-if="analysis.cached"> · cache</span>
        </div>
      </div>
      <div class="text-[11px] text-ink-muted">
        Cập nhật: {{ analyzedLabel(analysis.analyzedAt) }}
      </div>
    </div>

    <p
      v-if="analysis.narrative"
      class="text-sm text-ink-soft m-0 leading-relaxed"
    >
      {{ analysis.narrative }}
    </p>

    <div class="grid md:grid-cols-2 gap-4 items-start">
      <DevRadar
        :dimensions="analysis.dimensions"
        :previous="analysis.previousDimensions"
      />
      <div class="space-y-2">
        <div
          v-for="row in dimRows"
          :key="row.key"
          class="flex items-center justify-between text-xs py-1 border-b border-line last:border-0"
        >
          <span class="text-ink-muted">{{ row.label }}</span>
          <span>
            <span class="font-semibold text-ink tabular-nums">{{ row.value }}</span>
            <span class="ml-2" :class="trendClass(row.trend)">
              {{ fmtTrend(row.trend) }}
            </span>
          </span>
        </div>
        <p class="text-[10px] text-ink-muted m-0 pt-1">
          Viền đứt = kỳ trước · trend = Δ so kỳ trước
        </p>
      </div>
    </div>

    <div v-if="analysis.byTaskType?.length" class="text-xs">
      <div class="text-ink-muted mb-1">Theo loại task</div>
      <div
        v-for="t in analysis.byTaskType"
        :key="t.label"
        class="flex justify-between py-0.5 text-ink-soft"
      >
        <span>{{ t.label }} ({{ t.count }})</span>
        <span>
          ✓{{ t.succeeded }} · ✗{{ t.failed }}
          <span v-if="t.failRate != null"> · fail {{ t.failRate }}%</span>
        </span>
      </div>
    </div>

    <div v-if="analysis.recommendations.length">
      <div class="text-sm font-medium text-ink mb-2">Khuyến nghị</div>
      <div
        v-for="rec in analysis.recommendations"
        :key="rec.id"
        class="mb-2 rounded-lg border border-line p-3 text-sm cursor-pointer hover:border-accent/40 transition-colors"
        @click="onRecClick(rec)"
      >
        <div class="flex items-start gap-2">
          <span
            class="shrink-0 text-[10px] uppercase px-1.5 py-0.5 rounded"
            :class="{
              'bg-red-500/15 text-red-500': rec.severity === 'high',
              'bg-orange-500/15 text-orange-500': rec.severity === 'medium',
              'bg-line text-ink-muted': rec.severity === 'low',
            }"
          >
            {{ rec.severity }}
          </span>
          <p class="m-0 text-ink-soft">{{ rec.text }}</p>
        </div>
        <div
          v-if="rec.evidenceJobs.length"
          class="mt-2 pl-2 border-l-2 border-line space-y-1"
        >
          <div
            v-for="j in rec.evidenceJobs"
            :key="j.jobId"
            class="text-xs text-ink-muted"
          >
            <IssueIidLink :iid="j.issueIid" :url="j.url" />
            {{ j.title }}
          </div>
        </div>
      </div>
    </div>

    <ul
      v-if="analysis.dataGaps?.length"
      class="text-[10px] text-ink-muted m-0 pl-4 space-y-0.5"
    >
      <li v-for="(g, i) in analysis.dataGaps" :key="i">{{ g }}</li>
    </ul>
  </div>
</template>
