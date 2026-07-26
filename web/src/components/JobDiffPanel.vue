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
}>();

const loading = ref(false);
const modalLoading = ref(false);
const reverting = ref(false);
const listError = ref<string | null>(null);
const modalError = ref<string | null>(null);
const commits = ref<JobCommit[]>([]);

const modalOpen = ref(false);
const activeCommit = ref<JobCommit | null>(null);
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

async function loadCommits() {
  if (!props.jobId) {
    commits.value = [];
    return;
  }
  loading.value = true;
  listError.value = null;
  try {
    const res = await api<{ commits: JobCommit[]; branch?: string }>(
      `/api/jobs/${props.jobId}/commits`,
    );
    commits.value = res.commits || [];
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

async function openCommit(c: JobCommit) {
  activeCommit.value = c;
  modalOpen.value = true;
  await loadCommitDiff(c.sha);
}

function closeModal() {
  modalOpen.value = false;
  activeCommit.value = null;
  files.value = [];
  blocks.value = [];
  modalError.value = null;
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
      class="shrink-0 flex items-center gap-2 px-2.5 sm:px-3 py-2 border-b border-line bg-surface-soft/90"
    >
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
          v-if="!commits.length && !loading"
          class="rounded-xl border border-dashed border-line bg-surface-soft/60 px-4 py-10 text-center"
        >
          <div class="text-sm text-ink-muted">No commits on branch yet</div>
          <div
            class="text-xs text-ink-faint mt-1.5 max-w-sm mx-auto leading-relaxed"
          >
            After Run/chat (when the agent edits files), Flow commits via GitLab API — click ↻
            to reload.
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
              {{ activeCommit?.subject || "Commit" }}
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
              v-if="activeCommit"
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
              <button
                v-for="f in navFiles"
                :key="f.path"
                type="button"
                class="commit-file-item"
                :class="{ active: activePath === f.path }"
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
                  <span v-if="f.additions" class="add">+{{ f.additions }}</span>
                  <span v-if="f.deletions" class="del">−{{ f.deletions }}</span>
                </span>
              </button>
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
                <div class="text-[11px] shrink-0">
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
  outline: 2px solid rgba(15, 118, 110, 0.45);
  outline-offset: 1px;
}

.commit-modal-shell {
  display: flex;
  flex-direction: column;
  height: min(78vh, 720px);
  max-height: 100dvh;
  min-height: 320px;
  overflow: hidden;
  background: #fff;
}
.commit-modal-head {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid rgba(215, 224, 236, 0.9);
  background: rgba(248, 250, 252, 0.95);
}
.commit-modal-error {
  flex-shrink: 0;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  color: #e11d48;
  border-bottom: 1px solid rgba(215, 224, 236, 0.9);
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
  background: rgba(255, 255, 255, 0.55);
}
.commit-modal-files {
  flex: 0 0 220px;
  width: 220px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(215, 224, 236, 0.9);
  background: rgba(248, 250, 252, 0.7);
  overflow: hidden;
}
.commit-modal-files-title {
  flex-shrink: 0;
  padding: 0.4rem 0.65rem;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #94a3b8;
  border-bottom: 1px solid rgba(215, 224, 236, 0.7);
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
  gap: 0.4rem;
  text-align: left;
  padding: 0.5rem 0.65rem;
  border-bottom: 1px solid rgba(226, 232, 240, 0.8);
  background: transparent;
  cursor: pointer;
  transition: background 0.15s;
}
.commit-file-item:hover,
.commit-file-item.active {
  background: rgba(204, 251, 241, 0.55);
}
.commit-file-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: #334155;
  word-break: break-all;
  line-height: 1.35;
}
.commit-file-delta {
  flex-shrink: 0;
  font-size: 10px;
  white-space: nowrap;
}
.commit-file-delta .add {
  color: #059669;
}
.commit-file-delta .del {
  color: #e11d48;
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
  background: rgba(255, 255, 255, 0.92);
}
.gd-file {
  border-bottom: 1px solid rgba(215, 224, 236, 0.9);
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
  background: rgba(248, 250, 252, 0.96);
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
  backdrop-filter: blur(4px);
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
    border-bottom: 1px solid rgba(215, 224, 236, 0.9);
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
    border: 1px solid rgba(226, 232, 240, 0.9);
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
  border: 1px solid #cbd5e1;
  color: #64748b;
  background: #f8fafc;
}
.gd-badge--A {
  color: #15803d;
  border-color: #86efac;
  background: #dcfce7;
}
.gd-badge--M {
  color: #a16207;
  border-color: #fde68a;
  background: #fef9c3;
}
.gd-badge--D {
  color: #b91c1c;
  border-color: #fecaca;
  background: #fee2e2;
}
.gd-badge--R {
  color: #1d4ed8;
  border-color: #bfdbfe;
  background: #eff6ff;
}
.gd-table {
  width: 100%;
  min-width: 28rem;
  border-collapse: collapse;
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.45;
}
.gd-table .ln {
  width: 1%;
  min-width: 2.2rem;
  padding: 0 0.35rem;
  text-align: right;
  color: #94a3b8;
  user-select: none;
  vertical-align: top;
  border-right: 1px solid #e2e8f0;
  background: #f8fafc;
}
.gd-table .sign {
  width: 1%;
  padding: 0 0.3rem;
  text-align: center;
  user-select: none;
  vertical-align: top;
}
.gd-table .code {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0 0.5rem;
  vertical-align: top;
}
.gd-table tr.add .ln,
.gd-table tr.add .sign,
.gd-table tr.add .code {
  background: #dcfce7;
}
.gd-table tr.add .sign {
  color: #15803d;
  font-weight: 700;
}
.gd-table tr.del .ln,
.gd-table tr.del .sign,
.gd-table tr.del .code {
  background: #fee2e2;
}
.gd-table tr.del .sign {
  color: #b91c1c;
  font-weight: 700;
}
.gd-table tr.hunk .ln,
.gd-table tr.hunk .sign,
.gd-table tr.hunk .code {
  background: #e0f2fe;
  color: #0369a1;
}
</style>

<style>
.commit-diff-modal-wrap .ant-modal {
  max-width: 96vw;
  padding-bottom: 0;
}
.commit-diff-modal-wrap .ant-modal-content {
  overflow: hidden;
}
.commit-diff-modal-wrap .ant-modal-body {
  overflow: hidden !important;
  padding: 0 !important;
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
