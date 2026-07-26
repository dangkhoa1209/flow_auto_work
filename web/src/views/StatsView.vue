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
};

const loading = ref(false);
const daily = ref<DayBucket[]>([]);

onMounted(async () => {
  loading.value = true;
  try {
    const data = await api<{ daily?: DayBucket[] }>("/api/stats/daily?days=90");
    daily.value = data.daily || [];
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
        <a-collapse v-if="daily.length" accordion>
          <a-collapse-panel
            v-for="d in daily"
            :key="d.date"
            :header="`${d.date} · ${d.items?.length || 0} task · ✓${d.succeeded || 0} · ✗${d.failed || 0} · pending ${d.awaitingHandoff || 0}`"
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
