<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import {
  CloudSyncOutlined,
  HistoryOutlined,
} from "@ant-design/icons-vue";
import { useBaChatStore } from "@/stores/baChat";
import { useSyncDbStore } from "@/stores/syncDb";

const ba = useBaChatStore();
const sync = useSyncDbStore();
const popOpen = ref(false);

const projectId = computed(() => ba.selectedProjectId);

const syncDisabled = computed(
  () =>
    sync.triggering ||
    Boolean(
      projectId.value &&
        sync.jobs.some(
          (j) =>
            j.projectId === projectId.value &&
            (j.status === "queued" || j.status === "running"),
        ),
    ),
);

const progressText = computed(() => {
  const p = sync.queue.currentProgress;
  if (!p || !sync.queue.running) return "";
  const phase = p.phase === "restore" ? "restore" : p.phase;
  const cur = p.current.length ? p.current.join(", ") : "…";
  if (p.total > 0) return `${phase} ${p.done}/${p.total} · ${cur}`;
  return `${phase} · ${cur}`;
});

watch(
  projectId,
  (id) => {
    void sync.onProjectChange(id);
  },
  { immediate: true },
);

onMounted(() => {
  void sync.bootstrap(projectId.value);
});

onUnmounted(() => {
  sync.dispose();
});

async function onSync() {
  if (!projectId.value || syncDisabled.value) return;
  try {
    await sync.trigger(projectId.value);
    message.success(`Queued sync: ${sync.capability?.dbName || "DB"}`);
    popOpen.value = true;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onCancel(id: string) {
  try {
    await sync.cancel(id);
    message.success("Cancel requested");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

function statusColor(status: string): string {
  if (status === "success") return "text-emerald-600";
  if (status === "failed" || status === "timeout") return "text-red-600";
  if (status === "running") return "text-amber-600";
  if (status === "queued") return "text-sky-600";
  return "text-ink-muted";
}
</script>

<template>
  <a-popover
    v-if="sync.canShow"
    v-model:open="popOpen"
    trigger="click"
    placement="bottomRight"
  >
    <template #content>
      <div class="faw-sync-pop">
        <div class="faw-sync-pop__head">
          <div class="min-w-0">
            <div class="text-sm font-medium text-ink truncate">
              Sync Database
              <span v-if="sync.capability?.dbName" class="text-ink-muted font-normal">
                · {{ sync.capability.dbName }}
              </span>
            </div>
            <div v-if="progressText" class="text-xs text-amber-700 mt-0.5 truncate">
              {{ progressText }}
            </div>
            <div v-else-if="sync.queue.queued" class="text-xs text-ink-muted mt-0.5">
              Queue: {{ sync.queue.queued }} waiting (1 at a time system-wide)
            </div>
            <div v-else class="text-xs text-ink-muted mt-0.5">
              Idle — dump live → restore project Connect DB
            </div>
          </div>
          <button
            type="button"
            class="faw-btn faw-btn--primary shrink-0"
            :disabled="syncDisabled"
            @click="onSync"
          >
            <CloudSyncOutlined />
            Sync
          </button>
        </div>

        <div class="faw-sync-pop__hist">
          <div class="flex items-center gap-1 text-xs text-ink-muted mb-1.5">
            <HistoryOutlined />
            Recent
          </div>
          <p v-if="!sync.history.length" class="text-xs text-ink-muted m-0 py-2">
            No sync history yet
          </p>
          <div
            v-for="job in sync.history.slice(0, 12)"
            :key="job.id"
            class="faw-sync-pop__row"
          >
            <div class="min-w-0 flex-1">
              <div class="text-xs text-ink truncate">
                {{ job.dbName }}
                <span :class="statusColor(job.status)">· {{ job.status }}</span>
              </div>
              <div class="text-[11px] text-ink-muted truncate">
                @{{ job.triggeredBy }}
                <template v-if="job.progress?.total">
                  · {{ job.progress.done }}/{{ job.progress.total }}
                </template>
                <template v-if="job.errorMessage">
                  · {{ job.errorMessage }}
                </template>
              </div>
            </div>
            <a-popconfirm
              v-if="job.status === 'queued' || job.status === 'running'"
              title="Cancel this sync?"
              ok-text="Cancel job"
              cancel-text="Keep"
              ok-type="danger"
              @confirm="onCancel(job.id)"
            >
              <button type="button" class="faw-sync-pop__cancel">Cancel</button>
            </a-popconfirm>
          </div>
        </div>
      </div>
    </template>

    <button
      type="button"
      class="faw-topbar-chip"
      :title="sync.headerLabel"
      :disabled="false"
    >
      <span class="faw-idle__dot" :class="sync.idleDot" />
      <CloudSyncOutlined class="opacity-80" />
      <span class="hidden sm:inline max-w-[160px] truncate">{{
        sync.headerLabel
      }}</span>
    </button>
  </a-popover>
</template>

<style scoped>
.faw-sync-pop {
  width: min(360px, 92vw);
  max-height: 420px;
  overflow: auto;
}
.faw-sync-pop__head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line, #e5e7eb);
  margin-bottom: 8px;
}
.faw-sync-pop__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--line, #f0f0f0);
}
.faw-sync-pop__row:last-child {
  border-bottom: none;
}
.faw-sync-pop__cancel {
  font-size: 11px;
  color: #b91c1c;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
}
</style>
