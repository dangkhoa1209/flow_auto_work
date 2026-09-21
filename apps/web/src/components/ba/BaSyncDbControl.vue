<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import {
  CloudSyncOutlined,
} from "@ant-design/icons-vue";
import type { SyncDbJob, SyncDbStatus } from "@/api/syncDbApi";
import { useBaChatStore } from "@/stores/baChat";
import { useSyncDbStore } from "@/stores/syncDb";
import { formatBuildDurationMs } from "@/utils/formatBuildDuration";
import { formatChatTime } from "@/utils/formatChatTime";

const ba = useBaChatStore();
const sync = useSyncDbStore();
const popOpen = ref(false);
const nowTick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | undefined;

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
  const mine =
    Boolean(
      sync.queue.currentJobId &&
        sync.jobs.some((j) => j.id === sync.queue.currentJobId),
    ) ||
    Boolean(
      sync.queue.currentDbName &&
        sync.capability?.dbName &&
        sync.queue.currentDbName === sync.capability.dbName,
    );
  if (!mine) {
    return `Another project syncing · Queue: ${sync.queue.queued}`;
  }
  const cur = p.current.length ? p.current.join(", ") : "…";
  const cols = p.collections ?? 0;
  if (cols > 0 && (p.dumpDone != null || p.restoreDone != null)) {
    return `dump ${p.dumpDone ?? 0}/${cols} · restore ${p.restoreDone ?? 0}/${cols} · ${cur}`;
  }
  if (p.total > 0) return `${p.phase} ${p.done}/${p.total} · ${cur}`;
  return `${p.phase} · ${cur}`;
});

/** Active jobs first, then history — deduped, newest first. */
const timeline = computed(() => {
  const byId = new Map<string, SyncDbJob>();
  for (const j of sync.history) byId.set(j.id, j);
  for (const j of sync.jobs) byId.set(j.id, j);
  return [...byId.values()]
    .sort((a, b) => {
      const ta = Date.parse(a.startedAt || a.queuedAt || a.createdAt) || 0;
      const tb = Date.parse(b.startedAt || b.queuedAt || b.createdAt) || 0;
      return tb - ta;
    })
    .slice(0, 12);
});

const pendingJob = computed(() =>
  timeline.value.find((j) => j.status === "running" || j.status === "queued"),
);

const latestJob = computed(() => timeline.value[0] ?? null);

watch(
  projectId,
  (id) => {
    void sync.onProjectChange(id);
  },
  { immediate: true },
);

onMounted(() => {
  void sync.bootstrap(projectId.value);
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
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

function statusLabel(status: SyncDbStatus | string): string {
  if (status === "success") return "Success";
  if (status === "failed") return "Failed";
  if (status === "timeout") return "Timeout";
  if (status === "cancelled") return "Cancelled";
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  return status;
}

function statusTone(
  status: SyncDbStatus | string,
): "ok" | "warn" | "err" | "run" | "muted" {
  if (status === "success") return "ok";
  if (status === "failed" || status === "timeout") return "err";
  if (status === "running") return "run";
  if (status === "queued") return "warn";
  if (status === "cancelled") return "muted";
  return "muted";
}

function jobAtIso(job: SyncDbJob): string {
  return job.startedAt || job.queuedAt || job.createdAt;
}

function formatDuration(job: SyncDbJob): string {
  if (job.durationMs != null) return formatBuildDurationMs(job.durationMs);
  if (job.status === "running" && job.startedAt) {
    void nowTick.value;
    const t = Date.parse(job.startedAt);
    if (!Number.isFinite(t)) return "—";
    return formatBuildDurationMs(Date.now() - t);
  }
  return "—";
}

function errorPreview(job: SyncDbJob, max = 120): string {
  const msg = (job.errorMessage || "").trim();
  if (!msg) return "";
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}
</script>

<template>
  <a-popover
    v-if="sync.canShow"
    v-model:open="popOpen"
    trigger="click"
    placement="bottomRight"
    overlay-class-name="faw-sync-db-pop-overlay"
  >
    <template #content>
      <div class="faw-sync-db">
        <div class="faw-sync-db__head">
          <div class="min-w-0">
            <div class="faw-sync-db__title">
              Sync Database
              <span
                v-if="timeline.length"
                class="faw-sync-db__count"
                >{{ timeline.length }}</span
              >
            </div>
            <p class="faw-sync-db__hint">
              Dump live → restore
              <template v-if="sync.capability?.dbName">
                <code>{{ sync.capability.dbName }}</code>
              </template>
              <template v-else> project Connect DB</template>
              . One sync at a time system-wide.
            </p>
          </div>
          <button
            type="button"
            class="faw-btn faw-btn--primary shrink-0"
            :disabled="syncDisabled"
            :title="
              syncDisabled
                ? 'A sync is already queued or running for this project'
                : 'Queue a sync for this project DB'
            "
            @click="onSync"
          >
            <CloudSyncOutlined />
            {{ sync.triggering ? "Queuing…" : "Sync" }}
          </button>
        </div>

        <div
          v-if="pendingJob || progressText || sync.queue.queued"
          class="faw-sync-db__live"
          role="status"
        >
          <span class="faw-sync-db__live-dot" aria-hidden="true" />
          <div class="min-w-0">
            <div class="faw-sync-db__live-title">
              <template v-if="pendingJob?.status === 'queued'">
                Sync queued…
              </template>
              <template v-else-if="pendingJob || sync.queue.running">
                Sync in progress…
              </template>
              <template v-else> Queue busy </template>
            </div>
            <div class="faw-sync-db__live-meta">
              <template v-if="progressText">{{ progressText }}</template>
              <template v-else-if="sync.queue.queued">
                {{ sync.queue.queued }} waiting (1 at a time)
              </template>
              <template v-else-if="pendingJob">
                {{ pendingJob.dbName }} · {{ formatDuration(pendingJob) }}
              </template>
            </div>
          </div>
          <a-popconfirm
            v-if="pendingJob"
            title="Cancel this sync?"
            ok-text="Cancel job"
            cancel-text="Keep"
            ok-type="danger"
            @confirm="onCancel(pendingJob.id)"
          >
            <button type="button" class="faw-sync-db__cancel">Cancel</button>
          </a-popconfirm>
        </div>

        <div
          v-else-if="latestJob"
          class="faw-sync-db__latest"
        >
          <div class="faw-sync-db__latest-label">Latest</div>
          <div class="faw-sync-db__latest-row">
            <span class="faw-sync-db__pill">{{ latestJob.dbName }}</span>
            <span
              class="faw-sync-db__status"
              :class="`faw-sync-db__status--${statusTone(latestJob.status)}`"
              >{{ statusLabel(latestJob.status) }}</span
            >
            <span class="faw-sync-db__time tabular-nums">{{
              formatChatTime(jobAtIso(latestJob))
            }}</span>
            <span
              v-if="formatDuration(latestJob) !== '—'"
              class="faw-sync-db__dur tabular-nums"
              >{{ formatDuration(latestJob) }}</span
            >
          </div>
        </div>

        <ul v-if="timeline.length" class="faw-sync-db__list">
          <li
            v-for="job in timeline"
            :key="job.id"
            class="faw-sync-db__item"
            :class="`faw-sync-db__item--${statusTone(job.status)}`"
          >
            <div class="faw-sync-db__item-top">
              <div class="faw-sync-db__item-badges">
                <span class="faw-sync-db__pill">{{ job.dbName }}</span>
                <span
                  class="faw-sync-db__status"
                  :class="`faw-sync-db__status--${statusTone(job.status)}`"
                  >{{ statusLabel(job.status) }}</span
                >
              </div>
              <time
                class="faw-sync-db__time tabular-nums"
                :datetime="jobAtIso(job)"
                >{{ formatChatTime(jobAtIso(job)) }}</time
              >
            </div>
            <div class="faw-sync-db__meta">
              <span>@{{ job.triggeredBy }}</span>
              <span
                v-if="formatDuration(job) !== '—'"
                class="tabular-nums"
                >· {{ formatDuration(job) }}</span
              >
              <span
                v-if="job.progress?.total"
                class="tabular-nums"
                >· {{ job.progress.done }}/{{ job.progress.total }}</span
              >
            </div>
            <p v-if="errorPreview(job)" class="faw-sync-db__msg">
              {{ errorPreview(job) }}
            </p>
            <div
              v-if="
                (job.status === 'queued' || job.status === 'running') &&
                pendingJob?.id !== job.id
              "
              class="faw-sync-db__actions"
            >
              <a-popconfirm
                title="Cancel this sync?"
                ok-text="Cancel job"
                cancel-text="Keep"
                ok-type="danger"
                @confirm="onCancel(job.id)"
              >
                <button type="button" class="faw-sync-db__cancel">
                  Cancel
                </button>
              </a-popconfirm>
            </div>
          </li>
        </ul>

        <div v-else class="faw-sync-db__empty">
          <div class="faw-sync-db__empty-title">No syncs yet</div>
          <p class="faw-sync-db__empty-body">
            Pull a fresh copy of live Mongo into this project’s Connect DB.
          </p>
          <div class="faw-sync-db__empty-cta">
            <a-button
              size="small"
              type="primary"
              :loading="sync.triggering"
              :disabled="syncDisabled"
              @click="onSync"
            >
              <CloudSyncOutlined />
              Sync now
            </a-button>
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
