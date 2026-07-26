<script setup lang="ts">
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import IssueIidLink from "@/components/IssueIidLink.vue";
import { statusLabel } from "@/utils/status";

type DayItem = {
  issueIid?: number;
  title?: string;
  status?: string;
  url?: string;
};

type DayBucket = {
  date: string;
  items: DayItem[];
  succeeded?: number;
  failed?: number;
  awaitingHandoff?: number;
  tokensTotal?: number;
};

type ProjectTokens = {
  workspaceProjectId: string;
  jobs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type TokensSummary = {
  jobs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byProject: ProjectTokens[];
};

const loading = ref(false);
const daily = ref<DayBucket[]>([]);
const tokens = ref<TokensSummary | null>(null);

function fmtTokens(n?: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

onMounted(async () => {
  loading.value = true;
  try {
    const data = await api<{ daily?: DayBucket[]; tokens?: TokensSummary }>(
      "/api/stats/daily?days=90",
    );
    daily.value = data.daily || [];
    tokens.value = data.tokens || null;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="h-full max-h-full min-h-0 overflow-y-auto p-4">
    <div class="rounded-2xl panel-glass shadow-panel p-5 max-w-4xl">
      <h2 class="text-lg font-semibold text-ink mt-0 mb-4">
        Daily stats
      </h2>
      <a-spin :spinning="loading">
        <!-- Token usage summary (90 days) -->
        <div
          v-if="tokens && tokens.totalTokens > 0"
          class="mb-4 rounded-xl border border-line p-3"
        >
          <div class="text-sm font-medium text-ink mb-2">
            Token usage (90 ngày) —
            {{ fmtTokens(tokens.totalTokens) }} total ·
            in {{ fmtTokens(tokens.inputTokens) }} ·
            out {{ fmtTokens(tokens.outputTokens) }} ·
            {{ tokens.jobs }} jobs
          </div>
          <div
            v-for="p in tokens.byProject"
            :key="p.workspaceProjectId"
            class="flex items-center justify-between py-1 text-xs text-ink-soft border-b border-line last:border-0"
          >
            <span class="font-mono">{{ p.workspaceProjectId }}</span>
            <span>
              {{ fmtTokens(p.totalTokens) }} tokens · {{ p.jobs }} jobs
            </span>
          </div>
        </div>

        <a-collapse v-if="daily.length" accordion>
          <a-collapse-panel
            v-for="d in daily"
            :key="d.date"
            :header="`${d.date} · ${d.items?.length || 0} task · ✓${d.succeeded || 0} · ✗${d.failed || 0} · pending ${d.awaitingHandoff || 0}${d.tokensTotal ? ` · ${fmtTokens(d.tokensTotal)} tok` : ''}`"
          >
            <div
              v-for="(it, idx) in d.items || []"
              :key="idx"
              class="py-1.5 text-sm text-ink-soft border-b border-line last:border-0"
            >
              <IssueIidLink :iid="it.issueIid" :url="it.url" />
              {{ it.title }}
              <a-tag class="ml-2">{{ statusLabel(it.status) }}</a-tag>
            </div>
          </a-collapse-panel>
        </a-collapse>
        <a-empty v-else description="No data yet" />
      </a-spin>
    </div>
  </div>
</template>
