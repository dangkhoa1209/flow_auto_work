<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import {
  CopyOutlined,
  ReloadOutlined,
  UndoOutlined,
  FileTextOutlined,
} from "@ant-design/icons-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import {
  buildDiffBlocks,
  parseDiffRows,
  type DiffBlock,
  type DiffFileStat,
} from "@/utils/diffParse";

export type JobCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
};

const props = defineProps<{
  jobId: string | null;
  branch?: string | null;
  issueIid?: number | null;
  issueTitle?: string | null;
}>();

const emit = defineEmits<{
  updated: [];
}>();

const loading = ref(false);
const modalLoading = ref(false);
const reverting = ref(false);
const committing = ref(false);
const discarding = ref(false);
const grouping = ref(false);
const modeSaving = ref(false);
const listError = ref<string | null>(null);
const modalError = ref<string | null>(null);
const commits = ref<JobCommit[]>([]);
const commitMode = ref<"manual" | "auto">("auto");
const hasPendingChanges = ref(false);
const pendingFileCount = ref(0);
const commitMessage = ref("");

const modalOpen = ref(false);
const activeCommit = ref<JobCommit | null>(null);
const pendingModal = ref(false);
const groupOpen = ref(false);
const groupTitle = ref("");
const groupBody = ref("");
const files = ref<DiffFileStat[]>([]);
const blocks = ref<DiffBlock[]>([]);
const comparedLabel = ref("");
const activePath = ref<string | null>(null);
const bodyEl = ref<HTMLElement | null>(null);
const isMobile = ref(false);

function updateIsMobile() {
  isMobile.value =
    typeof window !== "undefined" ? window.matchMedia("(max-width: 640px)").matches : false;
}

const totalAdd = computed(() =>
  files.value.reduce((s, f) => s + (f.additions || 0), 0),
);
const totalDel = computed(() =>
  files.value.reduce((s, f) => s + (f.deletions || 0), 0),
);

const navFiles = computed<DiffFileStat[]>(() => {
  if (files.value.length) return files.value;
  return blocks.value.map((b) => ({
    path: b.path,
    status: "M",
    additions: 0,
    deletions: 0,
  }));
});

function fileStat(path: string): DiffFileStat | undefined {
  return files.value.find((x) => x.path === path);
}

async function copyText(text: string, ok = "Copied") {
  const t = text?.trim();
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    message.success(ok);
  } catch {
    message.error("Could not copy");
  }
}

function formatDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function defaultCommitMessage() {
  const iid = props.issueIid && props.issueIid > 0 ? props.issueIid : null;
  const title = (props.issueTitle || "").replace(/\s+/g, " ").trim();
  if (iid) return `feat #${iid} ${title || "changes"}`.trim();
  return title ? `hotfix: ${title}` : "feat: workbench changes";
}

async function loadCommits() {
  if (!props.jobId) {
    commits.value = [];
    hasPendingChanges.value = false;
    pendingFileCount.value = 0;
    return;
  }
  loading.value = true;
  listError.value = null;
  try {
    const res = await api<{
      commits: JobCommit[];
      branch?: string;
      commitMode?: "manual" | "auto";
      hasPendingChanges?: boolean;
      pendingFileCount?: number;
    }>(`/api/jobs/${props.jobId}/commits`);
    commits.value = res.commits || [];
    commitMode.value = res.commitMode === "manual" ? "manual" : "auto";
    const pending = Boolean(res.hasPendingChanges);
    const prevPending = hasPendingChanges.value;
    hasPendingChanges.value = pending;
    pendingFileCount.value = Number(res.pendingFileCount) || 0;
    if (!commitMessage.value.trim()) {
      commitMessage.value = defaultCommitMessage();
    }
    // Keep job.hasPendingChanges in store in sync (tab WIP badge)
    if (pending !== prevPending) emit("updated");
  } catch (e) {
    commits.value = [];
    listError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function loadCommitDiff(sha: string) {
  if (!props.jobId) return;
  modalLoading.value = true;
  modalError.value = null;
  files.value = [];
  blocks.value = [];
  try {
    const res = await api<{
      files?: DiffFileStat[];
      diff?: {
        rangeDiff?: string;
        staged?: string;
        unstaged?: string;
        comparedLabel?: string;
        files?: DiffFileStat[];
      };
    }>(`/api/jobs/${props.jobId}/diff?commit=${encodeURIComponent(sha)}`);
    const d = res.diff || {};
    files.value = res.files || d.files || [];
    blocks.value = buildDiffBlocks({
      rangeDiff: d.rangeDiff,
      staged: d.staged,
      unstaged: d.unstaged,
    });
    comparedLabel.value = d.comparedLabel || "";
    activePath.value = navFiles.value[0]?.path || null;
  } catch (e) {
    modalError.value = e instanceof Error ? e.message : String(e);
  } finally {
    modalLoading.value = false;
  }
}

async function loadPendingDiff() {
  if (!props.jobId) return;
  modalLoading.value = true;
  modalError.value = null;
  files.value = [];
  blocks.value = [];
  try {
    const res = await api<{
      files?: DiffFileStat[];
      diff?: {
        rangeDiff?: string;
        staged?: string;
        unstaged?: string;
        comparedLabel?: string;
        files?: DiffFileStat[];
      };
    }>(`/api/jobs/${props.jobId}/diff?pending=1`);
    const d = res.diff || {};
    files.value = res.files || d.files || [];
    blocks.value = buildDiffBlocks({
      rangeDiff: d.rangeDiff,
      staged: d.staged,
      unstaged: d.unstaged,
    });
    comparedLabel.value = d.comparedLabel || "working tree";
    activePath.value = navFiles.value[0]?.path || null;
  } catch (e) {
    modalError.value = e instanceof Error ? e.message : String(e);
  } finally {
    modalLoading.value = false;
  }
}

async function openCommit(c: JobCommit) {
  pendingModal.value = false;
  activeCommit.value = c;
  modalOpen.value = true;
  await loadCommitDiff(c.sha);
}

async function openPending() {
  pendingModal.value = true;
  activeCommit.value = null;
  modalOpen.value = true;
  await loadPendingDiff();
}

function closeModal() {
  modalOpen.value = false;
  pendingModal.value = false;
  activeCommit.value = null;
  files.value = [];
  blocks.value = [];
  modalError.value = null;
}

async function setCommitMode(checked: boolean) {
  if (!props.jobId) return;
  const next: "manual" | "auto" = checked ? "auto" : "manual";
  modeSaving.value = true;
  try {
    await api(API.jobs.commitMode(props.jobId), {
      method: "PATCH",
      body: JSON.stringify({ commitMode: next }),
    });
    commitMode.value = next;
    message.success(next === "auto" ? "Auto commit ON" : "Manual commit");
    emit("updated");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    modeSaving.value = false;
  }
}

async function runCommit() {
  if (!props.jobId) return;
  committing.value = true;
  try {
    const res = await api<{ commitSha: string }>(API.jobs.commit(props.jobId), {
      method: "POST",
      body: JSON.stringify({
        message: commitMessage.value.trim() || defaultCommitMessage(),
      }),
    });
    message.success(`Committed ${res.commitSha.slice(0, 8)}`);
    hasPendingChanges.value = false;
    if (modalOpen.value && pendingModal.value) closeModal();
    await loadCommits();
    emit("updated");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    committing.value = false;
  }
}

async function discardChanges(paths?: string[]) {
  if (!props.jobId) return;
  discarding.value = true;
  try {
    const res = await api<{
      all?: boolean;
      discarded?: string[];
      job?: { hasPendingChanges?: boolean };
    }>(API.jobs.discardChanges(props.jobId), {
      method: "POST",
      body: JSON.stringify(paths?.length ? { paths } : {}),
    });
    if (res.all) {
      message.success("Discarded all uncommitted changes");
      hasPendingChanges.value = false;
      if (modalOpen.value && pendingModal.value) closeModal();
    } else {
      const n = res.discarded?.length ?? paths?.length ?? 0;
      message.success(`Discarded ${n} file(s)`);
      hasPendingChanges.value = Boolean(res.job?.hasPendingChanges);
      if (pendingModal.value && modalOpen.value) {
        await loadPendingDiff();
        if (!files.value.length && !blocks.value.length) {
          closeModal();
          hasPendingChanges.value = false;
        }
      }
    }
    await loadCommits();
    emit("updated");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    discarding.value = false;
  }
}

function confirmDiscardAll(e?: Event) {
  e?.stopPropagation();
  Modal.confirm({
    title: "Discard all uncommitted changes?",
    content:
      "Working tree will be reset to HEAD. Untracked files will be deleted. This cannot be undone.",
    okText: "Discard all",
    okType: "danger",
    cancelText: "Cancel",
    centered: true,
    onOk: () => discardChanges(),
  });
}

function confirmDiscardFile(path: string, e?: Event) {
  e?.stopPropagation();
  Modal.confirm({
    title: "Discard this file?",
    content: `Revert 「${path}」 to HEAD (or delete if untracked).`,
    okText: "Discard",
    okType: "danger",
    cancelText: "Cancel",
    centered: true,
    onOk: () => discardChanges([path]),
  });
}

/** Newest-first list → title = latest subject; body = all subjects (oldest→newest). */
function buildGroupDefaults() {
  const list = commits.value;
  const newest = list[0];
  const oldestFirst = [...list].reverse();
  groupTitle.value =
    newest?.subject?.trim() ||
    defaultCommitMessage() ||
    "feat: grouped changes";
  groupBody.value = oldestFirst
    .map((c) => `* ${c.shortSha} ${c.subject}`)
    .join("\n");
}

function openGroupDialog() {
  if (hasPendingChanges.value || commits.value.length < 2) return;
  buildGroupDefaults();
  groupOpen.value = true;
}

async function confirmGroupOk() {
  if (!props.jobId) return;
  const title = groupTitle.value.trim();
  if (!title) {
    message.warning("Title is required");
    return Promise.reject();
  }
  grouping.value = true;
  try {
    const res = await api<{ commitSha: string; groupedCount?: number }>(
      API.jobs.groupCommit(props.jobId),
      {
        method: "POST",
        body: JSON.stringify({
          title,
          body: groupBody.value.trim() || undefined,
        }),
      },
    );
    message.success(
      `Grouped ${res.groupedCount ?? "n"} → ${res.commitSha.slice(0, 8)}`,
    );
    groupOpen.value = false;
    if (modalOpen.value) closeModal();
    await loadCommits();
    emit("updated");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
    return Promise.reject(e);
  } finally {
    grouping.value = false;
  }
}

function pickFile(path: string) {
  activePath.value = path;
  nextTick(() => {
    const el = bodyEl.value?.querySelector(
      `[data-path="${CSS.escape(path)}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function confirmRevert(c: JobCommit, e?: Event) {
  e?.stopPropagation();
  Modal.confirm({
    title: "Confirm revert commit",
    content: `This will create a new commit undoing changes from ${c.shortSha}.\n\n「${c.subject}」\n\nThis pushes to the current GitLab branch. Are you sure?`,
    okText: "Revert",
    okType: "danger",
    cancelText: "Cancel",
    centered: true,
    onOk: () => revertCommit(c),
  });
}

async function revertCommit(c: JobCommit) {
  if (!props.jobId) return;
  reverting.value = true;
  try {
    const res = await api<{ commitSha: string }>(
      `/api/jobs/${props.jobId}/commits/${encodeURIComponent(c.sha)}/revert`,
      { method: "POST", body: JSON.stringify({}) },
    );
    message.success(`Reverted → ${res.commitSha.slice(0, 8)}`);
    if (modalOpen.value) closeModal();
    await loadCommits();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    reverting.value = false;
  }
}

watch(
  () => props.jobId,
  async (id) => {
    commits.value = [];
    listError.value = null;
    if (modalOpen.value) closeModal();
    if (!id) return;
    await loadCommits();
  },
  { immediate: true },
);

onMounted(() => {
  updateIsMobile();
  window.addEventListener("resize", updateIsMobile);
});
onUnmounted(() => {
  window.removeEventListener("resize", updateIsMobile);
});
</script>

<template>
  <div class="job-diff relative h-full min-h-0 flex flex-col overflow-hidden">
    <div
      class="shrink-0 flex flex-col gap-2 px-2.5 sm:px-3 py-2 border-b border-line bg-surface-soft/90"
    >
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1 flex items-center gap-1.5 sm:gap-2">
          <span class="text-sm font-semibold text-ink shrink-0">Commits</span>
          <span
            v-if="commits.length"
            class="text-[11px] text-ink-faint bg-surface-muted px-1.5 py-0.5 rounded-md shrink-0"
            >{{ commits.length }}</span
          >
          <code
            v-if="branch"
            class="text-[10px] sm:text-[11px] font-mono text-ink-soft bg-surface-muted/80 px-1.5 py-0.5 rounded truncate min-w-0"
            :title="branch"
            >{{ branch }}</code
          >
          <a-button
            v-if="branch"
            type="text"
            size="small"
            class="!px-1 shrink-0"
            title="Copy branch"
            @click="copyText(branch || '', 'Branch copied')"
          >
            <template #icon><CopyOutlined /></template>
          </a-button>
        </div>
        <a-tooltip title="Auto commit after each Run (off = manual)">
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[10px] text-ink-faint hidden sm:inline">Auto</span>
            <a-switch
              size="small"
              :checked="commitMode === 'auto'"
              :loading="modeSaving"
              @change="(v: boolean) => setCommitMode(v)"
            />
          </div>
        </a-tooltip>
        <a-button
          type="text"
          size="small"
          class="shrink-0"
          :loading="loading"
          title="Reload"
          @click="loadCommits"
        >
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <a-input
          v-model:value="commitMessage"
          size="small"
          class="!flex-1 min-w-[10rem]"
          placeholder="Commit message"
          :disabled="committing"
        />
        <a-button
          type="primary"
          size="small"
          :loading="committing"
          :disabled="!hasPendingChanges || committing"
          @click="runCommit"
        >
          Commit
        </a-button>
        <a-tooltip
          :title="
            hasPendingChanges
              ? 'Commit pending changes before Group'
              : commits.length < 2
                ? 'Need ≥2 commits'
                : 'Squash job commits into 1'
          "
        >
          <a-button
            size="small"
            :loading="grouping"
            :disabled="
              hasPendingChanges || commits.length < 2 || grouping || committing
            "
            @click="openGroupDialog"
          >
            GR
          </a-button>
        </a-tooltip>
      </div>
    </div>

    <a-modal
      v-model:open="groupOpen"
      title="Group commits (GR)"
      ok-text="Xác nhận GR"
      cancel-text="Cancel"
      :confirm-loading="grouping"
      :ok-button-props="{ disabled: !groupTitle.trim() }"
      centered
      destroy-on-close
      @ok="confirmGroupOk"
    >
      <p class="text-xs text-ink-faint mb-3">
        Squash {{ commits.length }} commits → 1 (local commit + force-push).
        Review title/body before confirm.
      </p>
      <div class="space-y-3">
        <div>
          <div class="text-[11px] font-medium text-ink-soft mb-1">Title</div>
          <a-input
            v-model:value="groupTitle"
            placeholder="Commit title (subject)"
            :disabled="grouping"
          />
        </div>
        <div>
          <div class="text-[11px] font-medium text-ink-soft mb-1">
            Body (concatenated commits)
          </div>
          <a-textarea
            v-model:value="groupBody"
            :rows="8"
            placeholder="Optional description from old commits"
            :disabled="grouping"
          />
        </div>
      </div>
    </a-modal>

    <div
      v-if="listError"
      class="shrink-0 px-3 py-2 text-sm text-rose-600 border-b border-line"
    >
      {{ listError }}
    </div>

    <!-- Absolute scroll region — not clipped by ant-spin/flex overflow -->
    <div class="relative flex-1 min-h-0">
      <div
        v-if="loading"
        class="absolute inset-0 z-10 flex items-center justify-center bg-surface-raised/40 backdrop-blur-[1px]"
      >
        <a-spin />
      </div>
      <div
        class="absolute inset-0 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] p-2 sm:p-3 space-y-2"
      >
        <!-- Always visible: working tree (uncommitted) lives here -->
        <div
          class="commit-card w-full rounded-xl border px-2.5 sm:px-3 py-2.5"
          :class="
            hasPendingChanges
              ? 'border-amber-500/50 bg-amber-500/12'
              : 'border-line bg-surface-raised/60'
          "
        >
          <button
            type="button"
            class="w-full text-left hover:opacity-95 transition"
            :disabled="!hasPendingChanges"
            @click="openPending"
          >
            <div class="flex items-start gap-2 sm:gap-2.5">
              <div
                class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold"
                :class="
                  hasPendingChanges
                    ? 'bg-amber-500/25 text-amber-300'
                    : 'bg-surface-muted text-ink-faint'
                "
              >
                WIP
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium text-ink flex items-center gap-2">
                  Working tree
                  <span
                    v-if="hasPendingChanges"
                    class="text-[10px] font-semibold uppercase tracking-wide text-amber-300 bg-amber-500/20 px-1.5 py-0.5 rounded"
                  >
                    {{ pendingFileCount || "" }} uncommitted
                  </span>
                  <span
                    v-else
                    class="text-[10px] text-ink-faint font-normal"
                    >clean</span
                  >
                </div>
                <div class="text-[11px] text-ink-faint mt-0.5">
                  {{
                    hasPendingChanges
                      ? "Chưa commit — bấm View files để xem diff từng file"
                      : "Không có file change local. (Auto ON = commit ngay sau Run)"
                  }}
                </div>
              </div>
            </div>
          </button>
          <div
            v-if="hasPendingChanges"
            class="mt-2 flex flex-wrap items-center gap-2 pl-10"
          >
            <a-button size="small" type="primary" @click="openPending">
              View files
            </a-button>
            <a-button
              size="small"
              :loading="committing"
              :disabled="discarding || committing"
              @click="runCommit"
            >
              Commit
            </a-button>
            <a-button
              size="small"
              danger
              :loading="discarding"
              :disabled="discarding || committing"
              @click="confirmDiscardAll"
            >
              Discard all
            </a-button>
          </div>
        </div>
        <button
          v-for="c in commits"
          :key="c.sha"
          type="button"
          class="commit-card w-full text-left rounded-xl border border-line bg-surface-raised/80 active:bg-accent-soft/40 hover:border-accent/40 hover:bg-accent-soft/30 hover:shadow-sm transition px-2.5 sm:px-3 py-2.5"
          @click="openCommit(c)"
        >
          <div class="flex items-start gap-2 sm:gap-2.5">
            <div
              class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"
            >
              <FileTextOutlined class="text-sm" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-ink leading-snug line-clamp-2">
                {{ c.subject }}
              </div>
              <div
                class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-faint"
              >
                <code
                  class="font-mono text-accent bg-accent-soft/60 px-1.5 py-0.5 rounded"
                  >{{ c.shortSha }}</code
                >
                <span class="truncate max-w-[8rem] sm:max-w-[10rem]">{{
                  c.author
                }}</span>
                <span class="hidden xs:inline sm:inline">·</span>
                <span>{{ formatDate(c.date) }}</span>
              </div>
              <div class="mt-2 flex items-center gap-2 sm:hidden">
                <span class="text-[11px] text-accent">View changes</span>
                <a-button
                  type="default"
                  size="small"
                  danger
                  class="!ml-auto"
                  :loading="reverting"
                  :disabled="reverting"
                  @click="(e: Event) => confirmRevert(c, e)"
                >
                  <template #icon><UndoOutlined /></template>
                  Revert
                </a-button>
              </div>
            </div>
            <a-button
              type="default"
              size="small"
              danger
              class="!shrink-0 !hidden sm:!inline-flex"
              :loading="reverting"
              :disabled="reverting"
              @click="(e: Event) => confirmRevert(c, e)"
            >
              <template #icon><UndoOutlined /></template>
              Revert
            </a-button>
          </div>
        </button>

        <div
          v-if="!commits.length && !hasPendingChanges && !loading"
          class="rounded-xl border border-dashed border-line bg-surface-soft/60 px-4 py-10 text-center"
        >
          <div class="text-sm text-ink-muted">
            {{
              hasPendingChanges
                ? "Pending local changes — Commit when ready"
                : "No commits on branch yet"
            }}
          </div>
          <div
            class="text-xs text-ink-faint mt-1.5 max-w-sm mx-auto leading-relaxed"
          >
            Auto commit is on by default. Turn Auto off to keep edits local
            until you Commit.
          </div>
        </div>
        <!-- bottom spacer for mobile safe area -->
        <div class="h-4 sm:h-2" />
      </div>
    </div>

    <a-modal
      :open="modalOpen"
      :title="null"
      :footer="null"
      :width="isMobile ? '100%' : 920"
      :centered="!isMobile"
      :closable="true"
      destroy-on-close
      wrap-class-name="commit-diff-modal-wrap"
      :body-style="{ padding: 0, overflow: 'hidden' }"
      @cancel="closeModal"
    >
      <div class="commit-modal-shell">
        <div class="commit-modal-head">
          <div class="min-w-0 flex-1">
            <div class="text-sm sm:text-base font-semibold text-ink leading-snug line-clamp-2">
              {{
                pendingModal
                  ? "Uncommitted changes"
                  : activeCommit?.subject || "Commit"
              }}
            </div>
            <div
              class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint"
            >
              <code
                v-if="activeCommit"
                class="font-mono text-accent bg-accent-soft px-1.5 py-0.5 rounded"
                @click="copyText(activeCommit.sha, 'SHA copied')"
                >{{ activeCommit.shortSha }}</code
              >
              <span v-if="pendingModal" class="text-amber-300/90">{{
                comparedLabel || "working tree"
              }}</span>
              <span v-if="activeCommit" class="truncate max-w-[9rem]">{{
                activeCommit.author
              }}</span>
              <span v-if="activeCommit">{{
                formatDate(activeCommit.date)
              }}</span>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs whitespace-nowrap">
              <span class="text-emerald-600 font-semibold">+{{ totalAdd }}</span>
              <span class="text-rose-500 font-semibold ml-1">−{{ totalDel }}</span>
            </span>
            <a-button
              v-if="pendingModal && hasPendingChanges"
              type="primary"
              size="small"
              :loading="committing"
              :disabled="discarding"
              @click="runCommit"
            >
              Commit
            </a-button>
            <a-button
              v-if="pendingModal && hasPendingChanges"
              size="small"
              danger
              :loading="discarding"
              :disabled="committing"
              @click="confirmDiscardAll"
            >
              Discard all
            </a-button>
            <a-button
              v-if="activeCommit && !pendingModal"
              size="small"
              danger
              :loading="reverting"
              @click="confirmRevert(activeCommit)"
            >
              <template #icon><UndoOutlined /></template>
              <span class="hidden sm:inline">Revert</span>
            </a-button>
          </div>
        </div>

        <div v-if="modalError" class="commit-modal-error">
          {{ modalError }}
        </div>

        <div class="commit-modal-main">
          <div
            v-if="modalLoading"
            class="commit-modal-loading"
          >
            <a-spin />
          </div>

          <aside class="commit-modal-files">
            <div class="commit-modal-files-title">
              Files ({{ navFiles.length }})
            </div>
            <div class="commit-modal-files-list">
              <div
                v-for="f in navFiles"
                :key="f.path"
                class="commit-file-item"
                :class="{ active: activePath === f.path }"
              >
                <button
                  type="button"
                  class="commit-file-item-main"
                  :title="f.path"
                  @click="pickFile(f.path)"
                >
                  <span
                    class="gd-badge shrink-0"
                    :class="`gd-badge--${(f.status || 'M').charAt(0)}`"
                    >{{ f.status || "M" }}</span
                  >
                  <span class="commit-file-name">{{
                    isMobile ? f.path.split("/").pop() : f.path
                  }}</span>
                  <span class="commit-file-delta">
                    <span v-if="f.additions" class="add"
                      >+{{ f.additions }}</span
                    >
                    <span v-if="f.deletions" class="del"
                      >−{{ f.deletions }}</span
                    >
                  </span>
                </button>
                <button
                  v-if="pendingModal"
                  type="button"
                  class="commit-file-discard"
                  title="Discard this file"
                  :disabled="discarding"
                  @click="confirmDiscardFile(f.path, $event)"
                >
                  ✕
                </button>
              </div>
              <div
                v-if="!navFiles.length && !modalLoading"
                class="p-4 text-[11px] text-ink-faint text-center"
              >
                No changed files
              </div>
            </div>
          </aside>

          <div ref="bodyEl" class="commit-modal-diff">
            <section
              v-for="(b, i) in blocks"
              :key="`${b.path}-${i}`"
              class="gd-file"
              :data-path="b.path"
            >
              <div class="gd-file-head">
                <div class="flex items-center gap-2 min-w-0">
                  <span
                    class="gd-badge"
                    :class="`gd-badge--${(fileStat(b.path)?.status || 'M').charAt(0)}`"
                    >{{ fileStat(b.path)?.status || "M" }}</span
                  >
                  <span class="text-xs font-medium text-ink truncate">{{
                    b.path
                  }}</span>
                </div>
                <div class="text-[11px] shrink-0 flex items-center gap-2">
                  <span
                    v-if="fileStat(b.path)?.additions"
                    class="text-emerald-600 font-semibold"
                    >+{{ fileStat(b.path)?.additions }}</span
                  >
                  <span
                    v-if="fileStat(b.path)?.deletions"
                    class="text-rose-500 font-semibold ml-1"
                    >−{{ fileStat(b.path)?.deletions }}</span
                  >
                  <a-button
                    v-if="pendingModal"
                    size="small"
                    danger
                    type="text"
                    :disabled="discarding"
                    @click="confirmDiscardFile(b.path)"
                  >
                    Discard
                  </a-button>
                </div>
              </div>
              <div class="gd-file-table-wrap">
                <table class="gd-table" aria-label="diff">
                  <tbody>
                    <tr
                      v-for="(r, ri) in parseDiffRows(b.body).filter(
                        (x) => x.kind !== 'meta',
                      )"
                      :key="ri"
                      :class="r.kind"
                    >
                      <td class="ln">{{ r.oldNo }}</td>
                      <td class="ln">{{ r.newNo }}</td>
                      <td class="sign">{{ r.sign }}</td>
                      <td class="code">{{ r.text }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
            <div
              v-if="!blocks.length && !modalLoading && !modalError"
              class="p-10 text-center text-sm text-ink-faint"
            >
              No changes in this commit
            </div>
          </div>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.commit-card:focus-visible {
  outline: 2px solid rgba(91, 141, 239, 0.45);
  outline-offset: 1px;
}

.commit-modal-shell {
  display: flex;
  flex-direction: column;
  height: min(78vh, 720px);
  max-height: 100dvh;
  min-height: 320px;
  overflow: hidden;
  background: var(--app-panel);
  color: var(--app-ink);
}
.commit-modal-head {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-soft);
}
.commit-modal-error {
  flex-shrink: 0;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  color: #f87171;
  border-bottom: 1px solid var(--app-border);
}
.commit-modal-main {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}
.commit-modal-loading {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(13, 15, 20, 0.55);
}
.commit-modal-files {
  flex: 0 0 220px;
  width: 220px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--app-border);
  background: var(--app-panel-soft);
  overflow: hidden;
}
.commit-modal-files-title {
  flex-shrink: 0;
  padding: 0.4rem 0.65rem;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--app-faint);
  border-bottom: 1px solid var(--app-border);
}
.commit-modal-files-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
.commit-file-item {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 0.15rem;
  border-bottom: 1px solid var(--app-border);
  background: transparent;
  transition: background 0.15s;
}
.commit-file-item:hover,
.commit-file-item.active {
  background: rgba(91, 141, 239, 0.14);
}
.commit-file-item-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  text-align: left;
  padding: 0.5rem 0.35rem 0.5rem 0.65rem;
  background: transparent;
  border: 0;
  cursor: pointer;
  color: inherit;
}
.commit-file-discard {
  flex-shrink: 0;
  margin: 0.35rem 0.4rem 0 0;
  width: 1.4rem;
  height: 1.4rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--app-faint);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}
.commit-file-discard:hover:not(:disabled) {
  color: #f87171;
  background: rgba(239, 68, 68, 0.14);
}
.commit-file-discard:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.commit-file-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--app-ink);
  word-break: break-all;
  line-height: 1.35;
}
.commit-file-delta {
  flex-shrink: 0;
  font-size: 10px;
  white-space: nowrap;
}
.commit-file-delta .add {
  color: #34d399;
}
.commit-file-delta .del {
  color: #f87171;
  margin-left: 0.2rem;
}
.commit-modal-diff {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-x: auto;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  background: var(--app-bg);
}
.gd-file {
  border-bottom: 1px solid var(--app-border);
}
.gd-file-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: rgba(18, 21, 28, 0.96);
  border-bottom: 1px solid var(--app-border);
  backdrop-filter: blur(4px);
  color: var(--app-ink);
}
.gd-file-table-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

@media (max-width: 640px) {
  .commit-modal-shell {
    height: 100dvh;
    max-height: 100dvh;
    min-height: 100dvh;
  }
  .commit-modal-main {
    flex-direction: column;
  }
  .commit-modal-files {
    flex: 0 0 auto;
    width: 100%;
    max-height: 28%;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
  }
  .commit-modal-files-list {
    display: flex;
    flex-direction: row;
    gap: 0.4rem;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0.5rem;
  }
  .commit-file-item {
    width: auto;
    max-width: 70vw;
    flex-shrink: 0;
    border: 1px solid var(--app-border);
    border-radius: 0.5rem;
  }
  .commit-file-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: normal;
  }
  .commit-modal-diff {
    flex: 1 1 auto;
  }
}

.gd-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.15rem;
  padding: 0 0.3rem;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  border: 1px solid var(--app-border);
  color: var(--app-muted);
  background: var(--app-panel-soft);
}
.gd-badge--A {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.45);
  background: rgba(16, 185, 129, 0.16);
}
.gd-badge--M {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.4);
  background: rgba(245, 158, 11, 0.14);
}
.gd-badge--D {
  color: #fca5a5;
  border-color: rgba(248, 113, 113, 0.45);
  background: rgba(239, 68, 68, 0.16);
}
.gd-badge--R {
  color: #93c5fd;
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(59, 130, 246, 0.16);
}
.gd-table {
  width: 100%;
  min-width: 28rem;
  border-collapse: collapse;
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--app-ink);
}
.gd-table .ln {
  width: 1%;
  min-width: 2.2rem;
  padding: 0 0.35rem;
  text-align: right;
  color: var(--app-faint);
  user-select: none;
  vertical-align: top;
  border-right: 1px solid var(--app-border);
  background: var(--app-panel-soft);
}
.gd-table .sign {
  width: 1%;
  padding: 0 0.3rem;
  text-align: center;
  user-select: none;
  vertical-align: top;
  color: var(--app-muted);
}
.gd-table .code {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0 0.5rem;
  vertical-align: top;
  color: var(--app-ink);
}
.gd-table tr.add .ln,
.gd-table tr.add .sign,
.gd-table tr.add .code {
  background: rgba(16, 185, 129, 0.14);
}
.gd-table tr.add .sign,
.gd-table tr.add .code {
  color: #a7f3d0;
}
.gd-table tr.add .sign {
  font-weight: 700;
}
.gd-table tr.del .ln,
.gd-table tr.del .sign,
.gd-table tr.del .code {
  background: rgba(239, 68, 68, 0.14);
}
.gd-table tr.del .sign,
.gd-table tr.del .code {
  color: #fecaca;
}
.gd-table tr.del .sign {
  font-weight: 700;
}
.gd-table tr.hunk .ln,
.gd-table tr.hunk .sign,
.gd-table tr.hunk .code {
  background: rgba(59, 130, 246, 0.12);
  color: #93c5fd;
}
</style>

<style>
.commit-diff-modal-wrap .ant-modal {
  max-width: 96vw;
  padding-bottom: 0;
}
.commit-diff-modal-wrap .ant-modal-content {
  overflow: hidden;
  background: var(--app-panel) !important;
}
.commit-diff-modal-wrap .ant-modal-body {
  overflow: hidden !important;
  padding: 0 !important;
  background: var(--app-panel);
}
@media (max-width: 640px) {
  .commit-diff-modal-wrap .ant-modal {
    width: 100% !important;
    max-width: 100vw !important;
    margin: 0 !important;
    top: 0 !important;
    padding: 0 !important;
  }
  .commit-diff-modal-wrap .ant-modal-content {
    border-radius: 0;
    height: 100dvh;
  }
}
</style>
