<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { message, Modal } from "ant-design-vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { useSessionStore } from "@/stores/session";
import { useWorkStore, isAdhocJob } from "@/stores/work";
import {
  statusLabel,
  MANUAL_JOB_STATUSES,
  contextQualityLabel,
  contextQualityColor,
  CONTEXT_QUALITY_STANDARDS,
} from "@/utils/status";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import RelatedTaskPreviewModal from "@/components/RelatedTaskPreviewModal.vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import type { TaskDetail } from "@/stores/work";

const router = useRouter();
const session = useSessionStore();
const work = useWorkStore();
const {
  tasks,
  jobs,
  selectedTaskIid,
  selectedJobId,
  currentJob,
  taskDetail,
  chat,
  progressLines,
  progressLive,
  loading,
  jobLoading,
  labels,
  agentTyping,
} = storeToRefs(work);

const midTab = ref("detail");
const selectedIids = ref<number[]>([]);
const chatInput = ref("");
const clarifyInput = ref("");
const busy = ref(false);
const stopBusy = ref(false);
const notesSaving = ref(false);
const notesDraft = ref("");
const requireDocsFirst = ref(false);
const milestoneFilter = ref<string>("all");
const openIidDraft = ref("");

async function openTaskByIid() {
  const raw = openIidDraft.value.trim().replace(/^#/, "");
  const iid = Number(raw);
  if (!Number.isFinite(iid) || iid <= 0) {
    message.warning("Nhập #iid hợp lệ");
    return;
  }
  openIidDraft.value = "";
  await onSelectTask(iid);
}

const adhocOpen = ref(false);
const adhocTitle = ref("");
const adhocMessage = ref("");
const adhocBusy = ref(false);

const issueCreateOpen = ref(false);
const issueCreateBusy = ref(false);
const issueTitle = ref("");
const issueDescription = ref("");
const issueLabels = ref<string[]>([]);

const isCurrentAdhoc = computed(() => isAdhocJob(currentJob.value));

const milestones = computed(() => {
  const set = new Set<string>();
  for (const t of tasks.value) {
    const title = t.milestone?.title?.trim();
    if (title) set.add(title);
  }
  return ["all", ...Array.from(set).sort(), "__none__"];
});

const filteredTasks = computed(() => {
  return tasks.value.filter((t) => {
    if (milestoneFilter.value === "all") return true;
    if (milestoneFilter.value === "__none__") return !t.milestone?.title;
    return t.milestone?.title === milestoneFilter.value;
  });
});

/** Newest job first — prefer createdAt so ownership migrate can't reverse the list. */
const sortedJobs = computed(() => {
  return [...jobs.value].sort((a, b) => {
    const cb = Date.parse(b.createdAt || "") || 0;
    const ca = Date.parse(a.createdAt || "") || 0;
    if (cb !== ca) return cb - ca;
    const ub = Date.parse(b.updatedAt || "") || 0;
    const ua = Date.parse(a.updatedAt || "") || 0;
    if (ub !== ua) return ub - ua;
    return (b.issue?.issueIid || 0) - (a.issue?.issueIid || 0);
  });
});

/** Mobile workbench pane: one column at a time */
const mobilePane = ref<"tasks" | "detail" | "chat">("tasks");

const humanComments = computed(() =>
  (taskDetail.value?.notes || []).filter((n) => !n.system && n.body?.trim()),
);

const relatedIssues = computed(() => taskDetail.value?.related || []);

const contextQuality = computed(
  () => currentJob.value?.contextQuality || null,
);

const standardsOpen = ref(false);

const relatedPreviewOpen = ref(false);
const relatedPreviewLoading = ref(false);
const relatedPreview = ref<TaskDetail | null>(null);
const relatedPreviewError = ref<string | null>(null);
const relatedPreviewFallback = ref<{
  iid: number;
  title?: string;
  url?: string;
} | null>(null);

async function openRelatedPreview(opts: {
  iid: number;
  title?: string;
  url?: string;
}) {
  relatedPreviewFallback.value = opts;
  relatedPreviewOpen.value = true;
  relatedPreviewLoading.value = true;
  relatedPreviewError.value = null;
  relatedPreview.value = null;
  try {
    relatedPreview.value = await work.fetchTaskDetail(opts.iid);
  } catch (e) {
    relatedPreviewError.value = e instanceof Error ? e.message : String(e);
  } finally {
    relatedPreviewLoading.value = false;
  }
}

const detailTitle = computed(
  () =>
    taskDetail.value?.title ||
    currentJob.value?.issue?.title ||
    "",
);

const detailMeta = computed(() => {
  const d = taskDetail.value;
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

/** Force Stop khi đang chạy / chờ / stream live */
const canForceStop = computed(() => {
  if (!currentJob.value) return false;
  if (progressLive.value) return true;
  return [
    "queued",
    "running",
    "awaiting_clarification",
    "awaiting_docs_approval",
    "awaiting_diff_approval",
  ].includes(currentJob.value.status);
});

const agentWindowShort = computed(() => {
  const id = currentJob.value?.agentId?.trim();
  if (!id) return null;
  return id.length > 18 ? `${id.slice(0, 16)}…` : id;
});

const canResetWindow = computed(() => Boolean(currentJob.value));

const pendingClarify = computed(() => {
  const j = currentJob.value;
  if (j?.status === "awaiting_clarification" && j.lastQuestion) {
    return j.lastQuestion;
  }
  return null;
});

watch(
  currentJob,
  (j) => {
    notesDraft.value = (j?.devNotes || j?.techLeadNotes || "").trim();
    requireDocsFirst.value = Boolean(j?.requireDocsFirst);
  },
  { immediate: true },
);

watch(selectedJobId, (id) => {
  if (
    id &&
    ["running", "queued", "awaiting_clarification"].includes(
      currentJob.value?.status || "",
    )
  ) {
    midTab.value = "progress";
  }
});

const progressBox = ref<HTMLElement | null>(null);
const chatBox = ref<HTMLElement | null>(null);

function scrollChatToBottom() {
  const el = chatBox.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(
  () => progressLines.value.length,
  async () => {
    await nextTick();
    const el = progressBox.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

watch(
  () => [chat.value.length, agentTyping.value] as const,
  async () => {
    await nextTick();
    scrollChatToBottom();
  },
);

async function onSelectTask(iid: number) {
  midTab.value = "detail";
  mobilePane.value = "detail";
  try {
    await work.selectTask(iid);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onSelectJob(id: string) {
  if (jobLoading.value && selectedJobId.value === id) return;
  try {
    await work.selectJob(id);
    if (["running", "queued"].includes(currentJob.value?.status || "")) {
      midTab.value = "progress";
    } else {
      midTab.value = "detail";
    }
    mobilePane.value = "detail";
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

const jobStatusBusy = ref<string | null>(null);

async function onJobStatusChange(jobId: string, status: string) {
  if (!status) return;
  jobStatusBusy.value = jobId;
  try {
    const job = jobs.value.find((j) => j.id === jobId);
    const busy = ["queued", "running", "awaiting_clarification"].includes(
      job?.status || "",
    );
    await work.setJobStatus(jobId, status, { force: busy });
    message.success(`Đã đổi status → ${statusLabel(status)}`);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
    await work.loadJobs();
  } finally {
    jobStatusBusy.value = null;
  }
}

async function onDeleteJob(jobId: string) {
  jobStatusBusy.value = jobId;
  try {
    const job = jobs.value.find((j) => j.id === jobId);
    const busy = ["queued", "running", "awaiting_clarification"].includes(
      job?.status || "",
    );
    await work.deleteJob(jobId, { force: busy });
    message.success("Đã xóa job");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    jobStatusBusy.value = null;
  }
}

async function saveNotes() {
  notesSaving.value = true;
  try {
    await work.saveDevNotes({
      devNotes: notesDraft.value,
      requireDocsFirst: requireDocsFirst.value,
    });
    message.success("Đã lưu Dev Notes");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    notesSaving.value = false;
  }
}

async function ensureCursorKey() {
  if (session.me?.hasCursorApiKey) return true;
  message.warning("Cần Cursor API key — mở Settings → Cursor");
  router.push({ name: "settings-cursor" });
  return false;
}

async function runSelected() {
  if (!(await ensureCursorKey())) return;
  const iids =
    selectedIids.value.length > 0
      ? selectedIids.value
      : selectedTaskIid.value
        ? [selectedTaskIid.value]
        : [];
  if (!iids.length) {
    message.warning("Chọn task");
    return;
  }
  busy.value = true;
  try {
    await work.startJobs({
      mode: "selected",
      issueIids: iids,
      devNotes: notesDraft.value.trim() || undefined,
      requireDocsFirst: requireDocsFirst.value,
    });
    midTab.value = "progress";
    message.success("Đã đưa task vào hàng chờ chạy agent");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function runAll() {
  if (!(await ensureCursorKey())) return;
  busy.value = true;
  try {
    await work.startJobs({ mode: "all" });
    message.success("Đã đưa tất cả task vào hàng chờ");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function sendChat(mode: "continue" | "ask") {
  const msg = chatInput.value.trim();
  if (!msg) return;
  if (!selectedJobId.value) {
    message.warning("Chọn job trước");
    return;
  }
  if (!(await ensureCursorKey())) return;
  // Gửi ngay trên UI — clear input + hiện tin user + typing
  chatInput.value = "";
  busy.value = true;
  work.watchProgress();
  await nextTick();
  scrollChatToBottom();
  try {
    if (mode === "continue") await work.sendContinue(msg);
    else await work.sendAsk(msg);
  } catch (e) {
    const msgText = e instanceof Error ? e.message : String(e);
    if (/Force-stopped/i.test(msgText)) {
      message.info("Đã dừng chat");
    } else {
      message.error(msgText);
    }
  } finally {
    busy.value = false;
    await work.loadJobs().catch(() => undefined);
    await nextTick();
    scrollChatToBottom();
  }
}

async function sendClarify() {
  const a = clarifyInput.value.trim();
  if (!a || !selectedJobId.value) return;
  busy.value = true;
  try {
    await work.sendClarify(a);
    clarifyInput.value = "";
    message.success("Đã gửi clarify");
    await work.refreshJobChat(selectedJobId.value);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function forceStop() {
  if (!selectedJobId.value) return;
  stopBusy.value = true;
  try {
    await work.killJob(selectedJobId.value);
    message.success("Đã Force Stop");
    await work.refreshJobChat(selectedJobId.value);
    await work.loadJobs();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    stopBusy.value = false;
  }
}

function resetAgentWindow() {
  if (!selectedJobId.value) return;
  Modal.confirm({
    title: "Reset agent window?",
    content:
      "Dừng run nếu đang chạy, xóa liên kết cửa sổ Cursor cũ. Run / Gửi / Q&A sau sẽ mở window mới. Chat lịch sử trên UI vẫn giữ.",
    okText: "Reset window",
    okType: "danger",
    cancelText: "Hủy",
    onOk: async () => {
      busy.value = true;
      try {
        const res = await work.resetAgentWindow(selectedJobId.value!);
        message.success(
          res.killed
            ? "Đã dừng + reset window"
            : "Đã reset window — sẵn sàng cửa sổ mới",
        );
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      } finally {
        busy.value = false;
      }
    },
  });
}

async function refreshTasks() {
  busy.value = true;
  try {
    await Promise.all([work.loadTasks(), work.loadJobs()]);
    message.success("Đã refresh tasks");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

function statusColor(st: string) {
  if (st === "succeeded") return "success";
  if (st === "failed") return "error";
  if (st === "running" || st === "queued") return "processing";
  if (st?.startsWith("awaiting")) return "warning";
  return "default";
}

function jobDisplayIid(j: { issue?: { issueIid?: number }; kind?: string }) {
  const iid = j.issue?.issueIid;
  if (!iid || iid <= 0 || j.kind === "adhoc") return "Hotfix";
  return `#${iid}`;
}

async function openAdhocModal() {
  adhocTitle.value = "";
  adhocMessage.value = "";
  adhocOpen.value = true;
}

async function startAdhoc() {
  const title = adhocTitle.value.trim();
  if (!title) {
    message.warning("Nhập tiêu đề session");
    return;
  }
  if (!(await ensureCursorKey())) return;
  adhocBusy.value = true;
  try {
    const res = await work.createAdhocSession({
      title,
      message: adhocMessage.value.trim() || undefined,
    });
    adhocOpen.value = false;
    midTab.value = res.started ? "progress" : "detail";
    if (res.started) work.watchProgress();
    message.success(
      res.started ? "Đã mở Hotfix + gửi agent" : "Đã tạo session Hotfix",
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    adhocBusy.value = false;
  }
}

async function openCreateIssueModal() {
  if (!selectedJobId.value || !isCurrentAdhoc.value) return;
  issueCreateBusy.value = true;
  issueCreateOpen.value = true;
  try {
    const draft = await work.fetchIssueDraft(selectedJobId.value);
    issueTitle.value = draft.title;
    issueDescription.value = draft.description;
    issueLabels.value = [...(draft.labels || [])];
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
    issueCreateOpen.value = false;
  } finally {
    issueCreateBusy.value = false;
  }
}

async function submitCreateIssue() {
  if (!selectedJobId.value) return;
  const title = issueTitle.value.trim();
  if (!title) {
    message.warning("Nhập title issue");
    return;
  }
  issueCreateBusy.value = true;
  try {
    const res = await work.createGitlabIssue(selectedJobId.value, {
      title,
      description: issueDescription.value,
      labels: issueLabels.value,
    });
    issueCreateOpen.value = false;
    message.success(
      res.issueUrl
        ? `Đã tạo issue — ${res.issueUrl}`
        : "Đã tạo GitLab issue",
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    issueCreateBusy.value = false;
  }
}
</script>

<template>
  <div
    class="h-full max-h-full flex flex-col lg:grid lg:grid-cols-12 gap-2 sm:gap-3 p-2 sm:p-3 min-h-0 overflow-hidden"
  >
    <!-- Mobile pane switcher -->
    <div
      class="lg:hidden shrink-0 flex gap-1 p-1 rounded-xl bg-surface-muted/90 border border-line"
    >
      <button
        v-for="p in [
          { id: 'tasks' as const, label: 'Tasks' },
          { id: 'detail' as const, label: 'Issue' },
          { id: 'chat' as const, label: 'Chat' },
        ]"
        :key="p.id"
        type="button"
        class="flex-1 py-2 rounded-lg text-sm font-medium transition"
        :class="
          mobilePane === p.id
            ? 'bg-surface-raised text-accent shadow-sm'
            : 'text-ink-muted'
        "
        @click="mobilePane = p.id"
      >
        {{ p.label }}
      </button>
    </div>

    <!-- Left: tasks + jobs -->
    <aside
      class="flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel lg:col-span-3"
      :class="
        mobilePane === 'tasks' ? 'flex flex-1 min-h-0' : 'hidden lg:flex'
      "
    >
      <div class="shrink-0 p-2.5 sm:p-3 border-b border-line space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1 min-w-0">
            <span class="text-sm font-semibold text-ink">Tasks</span>
            <a-button
              type="text"
              size="small"
              :loading="busy || loading"
              title="Refresh tasks"
              @click="refreshTasks"
            >
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </div>
          <div class="flex gap-1 flex-wrap justify-end">
            <a-button size="small" @click="openAdhocModal">
              <template #icon><PlusOutlined /></template>
              <span class="hidden sm:inline">Hotfix</span>
            </a-button>
            <a-button size="small" type="primary" :loading="busy" @click="runSelected"
              >Run</a-button
            >
            <a-button size="small" :loading="busy" @click="runAll"
              >All</a-button
            >
          </div>
        </div>
        <a-select
          v-model:value="milestoneFilter"
          size="small"
          class="w-full"
          :options="
            milestones.map((m) => ({
              value: m,
              label:
                m === 'all'
                  ? 'All milestones'
                  : m === '__none__'
                    ? 'No milestone'
                    : m,
            }))
          "
        />
        <label class="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <span class="shrink-0">#iid</span>
          <a-input
            v-model:value="openIidDraft"
            size="small"
            class="flex-1 !text-xs"
            placeholder="Enter…"
            allow-clear
            @pressEnter="openTaskByIid"
          />
        </label>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        <a-spin :spinning="loading">
          <div
            v-for="t in filteredTasks"
            :key="t.issueIid"
            class="rounded-xl px-2.5 py-2 cursor-pointer hover:bg-surface-muted border border-transparent transition active:bg-surface-muted"
            :class="
              selectedTaskIid === t.issueIid
                ? '!border-accent/40 !bg-accent-soft'
                : ''
            "
            @click="onSelectTask(t.issueIid)"
          >
            <div class="flex items-start gap-2">
              <a-checkbox
                :checked="selectedIids.includes(t.issueIid)"
                @click.stop
                @change="
                  (e: { target: { checked: boolean } }) => {
                    if (e.target.checked)
                      selectedIids = [...selectedIids, t.issueIid];
                    else
                      selectedIids = selectedIids.filter(
                        (i) => i !== t.issueIid,
                      );
                  }
                "
              />
              <div class="min-w-0">
                <div class="text-xs font-semibold text-accent">
                  #{{ t.issueIid }}
                </div>
                <div class="text-sm text-ink-soft truncate">{{ t.title }}</div>
              </div>
            </div>
          </div>
          <div
            v-if="!filteredTasks.length"
            class="text-xs text-ink-faint p-3 text-center"
          >
            Không có task
          </div>
        </a-spin>
      </div>

      <!-- Jobs: header fixed, list scrolls — no sticky overlap -->
      <div
        class="shrink-0 border-t border-line flex flex-col h-[34%] min-h-[132px] max-h-[42%] bg-surface-soft/80 overflow-hidden"
      >
        <div
          class="shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-faint px-3 py-1.5 border-b border-line/60 bg-surface-soft"
        >
          Jobs
          <span class="normal-case font-normal text-ink-faint/80 ml-1"
            >({{ sortedJobs.length }})</span
          >
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 space-y-1">
          <div
            v-for="j in sortedJobs"
            :key="j.id"
            class="rounded-lg px-2 py-1.5 cursor-pointer hover:bg-surface-raised text-sm border border-transparent relative group/job active:bg-surface-raised"
            :class="
              selectedJobId === j.id
                ? '!bg-surface-raised !border-line shadow-sm'
                : ''
            "
            @click="onSelectJob(j.id)"
          >
            <div class="flex items-center gap-1.5 min-w-0">
              <div @click.stop>
                <a-dropdown
                  :trigger="['click']"
                  :disabled="jobStatusBusy === j.id"
                >
                  <a-tag
                    :color="statusColor(j.status)"
                    class="m-0 !text-[10px] !leading-4 !px-1.5 !py-0 cursor-pointer max-w-[7.5rem] truncate"
                  >
                    {{ statusLabel(j.status) }}
                    <span class="opacity-60 ml-0.5">▾</span>
                  </a-tag>
                  <template #overlay>
                    <a-menu
                      :selected-keys="[j.status]"
                      @click="
                        ({ key }: { key: string }) =>
                          onJobStatusChange(j.id, key)
                      "
                    >
                      <a-menu-item
                        v-if="
                          !(MANUAL_JOB_STATUSES as readonly string[]).includes(
                            j.status,
                          )
                        "
                        :key="j.status"
                        disabled
                      >
                        {{ statusLabel(j.status) }}
                      </a-menu-item>
                      <a-menu-item
                        v-for="s in MANUAL_JOB_STATUSES"
                        :key="s"
                      >
                        {{ statusLabel(s) }}
                      </a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown>
              </div>
              <a-tag
                v-if="j.contextQuality?.level"
                :color="contextQualityColor(j.contextQuality.level)"
                class="m-0 !text-[10px] !leading-4 !px-1 !py-0 shrink-0"
                :title="j.contextQuality.reason || ''"
              >
                {{
                  j.contextQuality.level === "good"
                    ? "Good"
                    : j.contextQuality.level === "searchable"
                      ? "Search"
                      : "Bad"
                }}
              </a-tag>
              <span class="text-accent text-xs font-semibold shrink-0">{{
                jobDisplayIid(j)
              }}</span>
              <a-spin
                v-if="jobLoading && selectedJobId === j.id"
                size="small"
                class="ml-auto"
              />
              <a-popconfirm
                v-else
                title="Xóa job này?"
                ok-text="Xóa"
                cancel-text="Huỷ"
                ok-type="danger"
                @confirm.stop="onDeleteJob(j.id)"
              >
                <button
                  type="button"
                  class="ml-auto shrink-0 text-[11px] leading-none text-ink-faint hover:text-red-500 opacity-100 sm:opacity-0 sm:group-hover/job:opacity-100 transition-opacity px-0.5"
                  :disabled="jobStatusBusy === j.id"
                  @click.stop
                  title="Xóa job"
                >
                  ×
                </button>
              </a-popconfirm>
            </div>
            <div class="truncate text-ink-muted text-xs mt-0.5">
              {{ j.issue?.title }}
            </div>
          </div>
          <div
            v-if="!sortedJobs.length"
            class="text-xs text-ink-faint p-2 text-center"
          >
            Chưa có job
          </div>
        </div>
      </div>
    </aside>

    <!-- Mid: tabs -->
    <section
      class="flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel relative lg:col-span-5"
      :class="
        mobilePane === 'detail' ? 'flex flex-1 min-h-0' : 'hidden lg:flex'
      "
    >
      <div
        v-if="jobLoading"
        class="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-surface-raised/55 backdrop-blur-[2px]"
      >
        <a-spin size="large" tip="Đang tải job…" />
      </div>
      <a-tabs
        v-model:activeKey="midTab"
        class="work-tabs flex-1 min-h-0 px-3 pt-1"
      >
        <a-tab-pane key="detail" tab="Issue">
          <div class="h-full min-h-0 overflow-y-auto pr-2 pb-3 space-y-4">
            <template v-if="taskDetail || currentJob">
              <a-alert
                v-if="isCurrentAdhoc"
                type="info"
                show-icon
                class="mt-2"
                message="Session Hotfix — chưa có GitLab issue"
                description=""
              >
                <template #action>
                  <a-button
                    size="small"
                    type="primary"
                    :loading="issueCreateBusy"
                    @click="openCreateIssueModal"
                    >Tạo issue GitLab</a-button
                  >
                </template>
              </a-alert>

              <div>
                <h2 class="text-base font-semibold text-ink mt-2 mb-1">
                  <template v-if="isCurrentAdhoc">
                    <span class="text-accent">Hotfix</span>
                    {{ detailTitle }}
                  </template>
                  <template v-else>
                    <a
                      v-if="taskDetail?.url || currentJob?.issue?.url"
                      :href="taskDetail?.url || currentJob?.issue?.url"
                      target="_blank"
                      rel="noopener"
                      class="text-accent hover:underline"
                      >#{{
                        taskDetail?.issueIid ||
                        currentJob?.issue?.issueIid ||
                        selectedTaskIid
                      }}</a
                    >
                    <span v-else
                      >#{{
                        taskDetail?.issueIid ||
                        currentJob?.issue?.issueIid ||
                        selectedTaskIid
                      }}</span
                    >
                    {{ detailTitle }}
                  </template>
                </h2>
                <p
                  v-if="isCurrentAdhoc && currentJob?.branch"
                  class="text-xs text-ink-faint m-0 mb-2 font-mono"
                >
                  {{ currentJob.branch }}
                  <span v-if="currentJob.commitSha">
                    · {{ currentJob.commitSha.slice(0, 8) }}</span
                  >
                </p>
                <p v-else-if="detailMeta" class="text-xs text-ink-faint m-0 mb-2">
                  {{ detailMeta }}
                </p>

                <div
                  class="mb-3 flex items-center gap-2 flex-wrap text-xs"
                >
                  <template v-if="contextQuality?.level">
                    <span class="text-[11px] uppercase tracking-wide text-ink-faint"
                      >Context</span
                    >
                    <a-tag
                      :color="contextQualityColor(contextQuality.level)"
                      class="m-0"
                      :title="contextQuality.reason || ''"
                      >{{ contextQualityLabel(contextQuality.level) }}</a-tag
                    >
                    <span
                      v-if="contextQuality.level === 'good'"
                      class="text-[11px] text-ink-faint"
                      >sticky</span
                    >
                  </template>
                  <a-button
                    size="small"
                    type="link"
                    class="!px-0 !h-auto"
                    @click="standardsOpen = true"
                    >Xem tiêu chuẩn</a-button
                  >
                </div>

                <a-alert
                  v-if="contextQuality?.level === 'bad'"
                  type="warning"
                  show-icon
                  class="mb-3"
                  message="Bad Context — Run/chat code bị chặn"
                  :description="
                    currentJob?.lastQuestion ||
                    'Bổ sung Dev Notes hoặc mô tả kỹ thuật rồi Run lại.'
                  "
                />

                <div
                  v-if="!isCurrentAdhoc && taskDetail?.labels?.length"
                  class="flex flex-wrap gap-1 mb-3"
                >
                  <a-tag
                    v-for="l in taskDetail.labels"
                    :key="l"
                    class="m-0"
                    >{{ l }}</a-tag
                  >
                </div>
                <div
                  v-if="isCurrentAdhoc"
                  class="text-sm text-ink-soft rounded-xl bg-surface-soft border border-line p-3"
                >
                  <ChatMessageBody
                    role="agent"
                    :markdown="true"
                    :body="
                      currentJob?.summary?.trim() ||
                      'Chưa có summary — chat với agent hoặc mô tả việc cần làm.'
                    "
                  />
                </div>
                <div
                  v-else
                  class="text-sm text-ink-soft rounded-xl bg-surface-soft border border-line p-3"
                >
                  <ChatMessageBody
                    role="agent"
                    :markdown="true"
                    :issue-url="taskDetail?.url || currentJob?.issue?.url"
                    :body="taskDetail?.description || ''"
                    empty="(không có description)"
                  />
                </div>
              </div>

              <template v-if="!isCurrentAdhoc">
              <div>
                <div
                  class="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2"
                >
                  Related / child
                  <span v-if="relatedIssues.length"
                    >({{ relatedIssues.length }})</span
                  >
                </div>
                <div v-if="relatedIssues.length" class="space-y-1.5">
                  <button
                    v-for="r in relatedIssues"
                    :key="r.iid"
                    type="button"
                    class="w-full text-left rounded-xl border border-line bg-surface-raised/70 px-3 py-2 hover:border-accent/40 hover:bg-accent-soft/40 transition"
                    @click="
                      openRelatedPreview({
                        iid: r.iid,
                        title: r.title,
                        url: r.url,
                      })
                    "
                  >
                    <div class="text-sm text-ink-soft">
                      <span class="text-accent font-semibold">#{{ r.iid }}</span>
                      — {{ r.title }}
                    </div>
                    <div class="text-xs text-ink-faint mt-0.5">
                      {{ r.state }} · {{ r.source
                      }}{{ r.linkType ? ` · ${r.linkType}` : "" }}
                    </div>
                  </button>
                </div>
                <div v-else class="text-xs text-ink-faint">
                  Không có related / child
                </div>
              </div>

              <div>
                <div
                  class="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2"
                >
                  Comments
                  <span v-if="humanComments.length"
                    >({{ humanComments.length }})</span
                  >
                </div>
                <div v-if="humanComments.length" class="space-y-2">
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
                    <ChatMessageBody
                      class="text-sm text-ink-soft"
                      role="agent"
                      :markdown="true"
                      :issue-url="taskDetail?.url || currentJob?.issue?.url"
                      :body="n.body"
                    />
                  </div>
                </div>
                <div v-else class="text-xs text-ink-faint">Chưa có comment</div>
              </div>
              </template>

              <div class="rounded-xl border border-line bg-accent-soft/30 p-3">
                <div class="flex items-center justify-between gap-2 mb-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <div
                      class="text-xs font-semibold uppercase tracking-wide text-accent"
                    >
                      Dev Notes
                    </div>
                    <a-button
                      size="small"
                      type="link"
                      class="!px-0 !h-auto !text-[11px]"
                      @click="standardsOpen = true"
                      >tiêu chuẩn</a-button
                    >
                  </div>
                  <a-button
                    size="small"
                    type="primary"
                    :loading="notesSaving"
                    @click="saveNotes"
                    >Lưu</a-button
                  >
                </div>
                <a-textarea
                  v-model:value="notesDraft"
                  :rows="4"
                  placeholder="Chỉ dẫn kỹ thuật rõ ràng (≥ ~25 từ + file/route/field…) → Good Context"
                />
                <a-checkbox v-model:checked="requireDocsFirst" class="mt-2">
                  Docs-first (agent đọc docs trước khi code)
                </a-checkbox>
              </div>
            </template>
            <a-empty v-else description="Chọn task hoặc job" />
          </div>
        </a-tab-pane>
        <a-tab-pane key="progress" tab="Progress">
          <div
            ref="progressBox"
            class="mono-log h-full min-h-0 overflow-y-auto p-3 rounded-xl bg-surface-soft border border-line"
            :class="progressLive ? 'ring-2 ring-accent-glow/50' : ''"
          >
            <div
              v-for="l in progressLines"
              :key="l.id"
              class="mb-2 border-b border-line pb-1.5"
            >
              <span class="text-accent font-medium">{{ l.kind }}</span>
              <span class="text-ink-faint ml-2">{{
                new Date(l.at).toLocaleTimeString()
              }}</span>
              <div
                class="text-ink-soft"
                :class="
                  l.kind === 'prompt'
                    ? 'whitespace-pre-wrap break-words mt-1 max-h-80 overflow-y-auto rounded-lg bg-surface-raised/80 p-2 text-[11px] leading-relaxed border border-line'
                    : ''
                "
              >
                {{ l.text }}
              </div>
            </div>
            <div
              v-if="!progressLines.length"
              class="text-ink-faint text-center py-8"
            >
              {{
                progressLive ? "Đang chờ Cursor stream…" : "Chưa có progress"
              }}
            </div>
          </div>
        </a-tab-pane>
        <a-tab-pane key="diff" tab="Diff" disabled>
          <a-empty description="Mở Diff từ Handoff (phase sau)" />
        </a-tab-pane>
      </a-tabs>
    </section>

    <!-- Right: chat -->
    <aside
      class="flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel relative lg:col-span-4"
      :class="mobilePane === 'chat' ? 'flex flex-1 min-h-0' : 'hidden lg:flex'"
    >
      <div
        v-if="jobLoading"
        class="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-surface-raised/55 backdrop-blur-[2px]"
      >
        <a-spin size="large" tip="Đang tải chat…" />
      </div>
      <div
        class="shrink-0 px-3 py-2.5 border-b border-line flex items-center justify-between gap-2 bg-gradient-to-r from-accent-soft/60 to-transparent"
      >
        <div class="min-w-0">
          <div class="font-semibold text-sm text-ink">Chat agent</div>
          <div
            v-if="agentWindowShort"
            class="text-[10px] font-mono text-ink-faint truncate"
            :title="currentJob?.agentId || ''"
          >
            window {{ agentWindowShort }}
          </div>
          <div v-else class="text-[10px] text-ink-faint">
            chưa gắn window
          </div>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap justify-end shrink-0">
          <a-button
            v-if="canForceStop"
            size="small"
            danger
            :loading="stopBusy"
            :disabled="stopBusy"
            @click="forceStop"
            >Force Stop</a-button
          >
          <a-button
            v-if="canResetWindow"
            size="small"
            :loading="busy"
            :disabled="!currentJob"
            @click="resetAgentWindow"
            >Reset window</a-button
          >
          <a-tag v-if="currentJob" :color="statusColor(currentJob.status)">{{
            statusLabel(currentJob.status)
          }}</a-tag>
          <a-tag
            v-if="contextQuality?.level"
            :color="contextQualityColor(contextQuality.level)"
            :title="contextQuality.reason || ''"
            >{{ contextQualityLabel(contextQuality.level) }}</a-tag
          >
        </div>
      </div>

      <div ref="chatBox" class="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        <div
          v-for="(m, i) in chat"
          :key="i"
          class="rounded-xl px-3 py-2 text-sm border"
          :class="
            m.role === 'user'
              ? 'bg-accent-soft border-accent/20 ml-4 text-ink'
              : m.role === 'agent'
                ? 'bg-surface-raised border-line mr-2 text-ink-soft'
                : 'bg-surface-muted border-transparent text-ink-muted'
          "
        >
          <div
            class="text-[10px] uppercase tracking-wide text-ink-faint font-semibold mb-1"
          >
            {{ m.role }}
          </div>
          <ChatMessageBody :role="m.role" :body="m.body" />
        </div>

        <div
          v-if="agentTyping"
          class="rounded-xl px-3 py-2.5 text-sm border border-line bg-surface-raised mr-2 inline-flex items-center gap-2"
        >
          <span
            class="text-[10px] uppercase tracking-wide text-ink-faint font-semibold"
            >agent</span
          >
          <span class="chat-typing" aria-label="Đang suy nghĩ">
            <span /><span /><span />
          </span>
          <span class="text-xs text-ink-faint">đang suy nghĩ…</span>
        </div>

        <a-empty
          v-if="!chat.length && !agentTyping"
          description="Chat trống — Run hoặc Gửi"
        />
      </div>

      <div v-if="pendingClarify" class="shrink-0 px-3 pb-2">
        <a-alert type="warning" show-icon :message="pendingClarify" />
        <a-textarea
          v-model:value="clarifyInput"
          class="mt-2"
          :rows="2"
          placeholder="Trả lời clarify…"
        />
        <a-button
          type="primary"
          size="small"
          class="mt-1"
          :loading="busy"
          @click="sendClarify"
          >Gửi clarify</a-button
        >
      </div>

      <div class="shrink-0 p-3 border-t border-line space-y-2 bg-surface-soft/70">
        <a-textarea
          v-model:value="chatInput"
          :rows="3"
          :disabled="busy || agentTyping"
          placeholder="Hỏi / sửa / làm thêm (IDE follow-up)…"
          @keydown.meta.enter="sendChat('continue')"
        />
        <div class="flex gap-2">
          <a-button
            type="primary"
            class="flex-1"
            :loading="busy || agentTyping"
            :disabled="busy || agentTyping"
            @click="sendChat('continue')"
            >Gửi</a-button
          >
          <a-button
            :loading="busy || agentTyping"
            :disabled="busy || agentTyping"
            @click="sendChat('ask')"
            >Chỉ hỏi</a-button
          >
        </div>
      </div>
    </aside>

    <a-modal
      v-model:open="adhocOpen"
      title="New session / Hotfix"
      ok-text="Bắt đầu"
      cancel-text="Hủy"
      :confirm-loading="adhocBusy"
      @ok="startAdhoc"
    >
      <a-form layout="vertical" class="mt-2">
        <a-form-item label="Tiêu đề" required>
          <a-input
            v-model:value="adhocTitle"
            placeholder="vd. Hotfix crash login mobile"
            @pressEnter="startAdhoc"
          />
        </a-form-item>
        <a-form-item label="Yêu cầu đầu (optional)">
          <a-textarea
            v-model:value="adhocMessage"
            :rows="4"
            placeholder="Mô tả việc cần agent làm…"
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="issueCreateOpen"
      title="Tạo GitLab issue"
      ok-text="Tạo issue"
      cancel-text="Hủy"
      :confirm-loading="issueCreateBusy"
      :width="640"
      @ok="submitCreateIssue"
    >
      <a-spin :spinning="issueCreateBusy && !issueTitle">
        <a-form layout="vertical" class="mt-2">
          <a-form-item label="Title" required>
            <a-input v-model:value="issueTitle" />
          </a-form-item>
          <a-form-item label="Description">
            <a-textarea v-model:value="issueDescription" :rows="10" />
          </a-form-item>
          <a-form-item label="Labels">
            <a-select
              v-model:value="issueLabels"
              mode="multiple"
              class="w-full"
              :options="labels.map((l) => ({ value: l, label: l }))"
              placeholder="Optional"
            />
          </a-form-item>
        </a-form>
      </a-spin>
    </a-modal>

    <a-modal
      v-model:open="standardsOpen"
      title="Tiêu chuẩn Context Quality"
      :footer="null"
      :width="520"
      destroy-on-close
    >
      <p class="text-xs text-ink-muted m-0 mb-3 leading-relaxed">
        Gate khi Run / chat follow-up. Dev Notes rõ ràng (đủ dài + tín hiệu kỹ
        thuật) được coi là <strong>Good</strong>.
      </p>
      <div
        v-for="(std, key) in CONTEXT_QUALITY_STANDARDS"
        :key="key"
        class="mb-3 last:mb-0 rounded-xl border border-line px-3 py-2.5"
      >
        <div class="flex items-center gap-2 mb-1.5">
          <a-tag :color="contextQualityColor(key)" class="m-0">{{
            contextQualityLabel(key)
          }}</a-tag>
          <span class="text-xs text-ink-soft">{{ std.title }}</span>
        </div>
        <ul class="m-0 pl-4 text-sm text-ink-soft leading-relaxed">
          <li v-for="(item, i) in std.items" :key="i">{{ item }}</li>
        </ul>
      </div>
    </a-modal>

    <RelatedTaskPreviewModal
      v-model:open="relatedPreviewOpen"
      :loading="relatedPreviewLoading"
      :detail="relatedPreview"
      :error="relatedPreviewError"
      :fallback="relatedPreviewFallback"
    />
  </div>
</template>
