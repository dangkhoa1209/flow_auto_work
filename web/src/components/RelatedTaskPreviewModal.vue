<script setup lang="ts">
import { computed } from "vue";
import type { TaskDetail } from "@/stores/work";

const props = defineProps<{
  open: boolean;
  loading?: boolean;
  detail: TaskDetail | null;
  error?: string | null;
  /** Fallback when detail chưa load xong */
  fallback?: { iid: number; title?: string; url?: string } | null;
}>();

const emit = defineEmits<{
  "update:open": [boolean];
}>();

const openProxy = computed({
  get: () => props.open,
  set: (v: boolean) => emit("update:open", v),
});

const title = computed(
  () =>
    props.detail?.title ||
    props.fallback?.title ||
    (props.fallback?.iid ? `#${props.fallback.iid}` : "Task"),
);

const iid = computed(
  () => props.detail?.issueIid || props.fallback?.iid || null,
);

const url = computed(() => props.detail?.url || props.fallback?.url || "");

const humanComments = computed(() =>
  (props.detail?.notes || []).filter((n) => !n.system && n.body?.trim()),
);

const meta = computed(() => {
  const d = props.detail;
  if (!d) return "";
  const assignees =
    (d.assignees || []).map((a) => `@${a.username}`).join(", ") || "—";
  const parts = [d.state || "—", `assignee ${assignees}`];
  if (d.taskCompletion) {
    parts.push(
      `checklist ${d.taskCompletion.completedCount}/${d.taskCompletion.count}`,
    );
  }
  if (d.milestone?.title) parts.push(`milestone ${d.milestone.title}`);
  return parts.join(" · ");
});
</script>

<template>
  <a-modal
    v-model:open="openProxy"
    :footer="null"
    width="640px"
    :title="iid ? `#${iid} — ${title}` : 'Task'"
  >
    <a-spin :spinning="Boolean(loading)">
      <a-alert
        v-if="error"
        type="error"
        show-icon
        class="mb-3"
        :message="error"
      />

      <template v-else>
        <div class="flex items-center justify-between gap-2 mb-3">
          <div class="text-xs text-ink-faint min-w-0 truncate">
            {{ meta || "…" }}
          </div>
          <a
            v-if="url"
            :href="url"
            target="_blank"
            rel="noreferrer"
            class="text-xs text-accent shrink-0 hover:underline"
            >GitLab ↗</a
          >
        </div>

        <div
          v-if="detail?.labels?.length"
          class="flex flex-wrap gap-1 mb-3"
        >
          <a-tag v-for="l in detail.labels" :key="l" class="m-0">{{ l }}</a-tag>
        </div>

        <div
          class="text-sm text-ink-soft whitespace-pre-wrap rounded-xl bg-surface-soft border border-line p-3 max-h-[40vh] overflow-y-auto"
        >
          {{ detail?.description?.trim() || "(không có description)" }}
        </div>

        <div class="mt-4">
          <div
            class="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2"
          >
            Comments
            <span v-if="humanComments.length"
              >({{ humanComments.length }})</span
            >
          </div>
          <div
            v-if="humanComments.length"
            class="space-y-2 max-h-[24vh] overflow-y-auto"
          >
            <div
              v-for="n in humanComments"
              :key="n.id"
              class="rounded-xl border border-line bg-surface-raised/60 px-3 py-2"
            >
              <div class="text-xs text-ink-faint mb-1">
                @{{ n.author }}
                <span v-if="n.createdAt">
                  · {{ new Date(n.createdAt).toLocaleString() }}</span
                >
              </div>
              <div class="text-sm text-ink-soft whitespace-pre-wrap">
                {{ n.body }}
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-ink-faint">Chưa có comment</div>
        </div>
      </template>
    </a-spin>
  </a-modal>
</template>
