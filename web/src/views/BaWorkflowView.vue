<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons-vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useBaChatStore } from "@/stores/baChat";
import { useSessionStore } from "@/stores/session";
import {
  baApi,
  WORKFLOW_STEPS,
  WORKFLOW_STEP_ORDER,
  type BaRequirement,
  type BaTaskDraft,
  type BaWorkflowStepKey,
} from "@/api/baApi";
import { API } from "@/api/endpoints";
import { api } from "@/api/client";
import BaTaskFormModal from "@/components/ba/BaTaskFormModal.vue";
import BaMessageList from "@/components/ba/BaMessageList.vue";
import BaComposer from "@/components/ba/BaComposer.vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import { useBaGitPat } from "@/composables/useBaGitPat";
import { useBaWorkflowPanes } from "@/composables/useBaWorkflowPanes";
import { connectRealtime } from "@/realtime/client";
import type {
  RealtimeBaDone,
  RealtimeBaError,
  RealtimeBaMessage,
  RealtimeBaProgress,
  RealtimeBaWfStepDone,
  RealtimeBaWfStepError,
  RealtimeBaWfStepProgress,
} from "@/realtime/client";

type WfMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

type WfProgressItem = {
  step: RealtimeBaProgress["step"];
  label: string;
  detail?: string;
  at: string;
};

const ba = useBaChatStore();
const session = useSessionStore();
const panes = reactive(useBaWorkflowPanes());
const { requireGitPat, handleBaPatApiError } = useBaGitPat();

const requirements = ref<BaRequirement[]>([]);
const selectedId = ref<string | null>(null);
const taskDrafts = ref<BaTaskDraft[]>([]);
const taskDraft = computed(() => taskDrafts.value[0] || null);
const loading = ref(false);

const ycTitle = ref("");
const ycContent = ref("");
const ycBaNote = ref("");

const flowRunning = ref(false);
const flowPaused = ref(false);
const flowPauseReason = ref("");
/** YC gốc không phải yêu cầu nghiệp vụ (chào hỏi, rác) — flow đã dừng hẳn. */
const flowInvalidReason = ref("");
const flowResumeFrom = ref(0);
const flowAbort = ref(false);
const activeFlowStep = ref<BaWorkflowStepKey | null>(null);
const flowStepLabel = ref("");

/** Sửa YC gốc / BA đàm phán tại chỗ. */
const editingYc = ref(false);
const editYcTitle = ref("");
const editYcContent = ref("");
const editYcBaNote = ref("");
const editYcSaving = ref(false);

const WF_STEP_TIMEOUT_MS = 12 * 60 * 1000;
type WfStepWaiter = {
  resolve: (ev: RealtimeBaWfStepDone) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const wfStepWaiters = new Map<string, WfStepWaiter>();

function wfStepWaitKey(requirementId: string, step: string) {
  return `${requirementId}:${step}`;
}

function waitForWorkflowStep(
  requirementId: string,
  step: BaWorkflowStepKey,
): Promise<RealtimeBaWfStepDone> {
  const key = wfStepWaitKey(requirementId, step);
  const existing = wfStepWaiters.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    wfStepWaiters.delete(key);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wfStepWaiters.delete(key);
      reject(new Error("Workflow step timeout — thử Run flow lại"));
    }, WF_STEP_TIMEOUT_MS);
    wfStepWaiters.set(key, { resolve, reject, timer });
  });
}

function settleWfStepDone(ev: RealtimeBaWfStepDone) {
  const key = wfStepWaitKey(ev.requirementId, ev.step);
  const waiter = wfStepWaiters.get(key);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  wfStepWaiters.delete(key);
  waiter.resolve(ev);
}

function settleWfStepError(ev: RealtimeBaWfStepError) {
  const key = wfStepWaitKey(ev.requirementId, ev.step);
  const waiter = wfStepWaiters.get(key);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  wfStepWaiters.delete(key);
  waiter.reject(new Error(ev.error));
}

function clearWfStepWaiters(reason = "Đã dừng flow") {
  for (const waiter of wfStepWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
  wfStepWaiters.clear();
}

const wfThreadId = ref<string | null>(null);
const wfMessages = ref<WfMessage[]>([]);
const wfStreaming = ref(false);
const wfStreamingMessageId = ref<string | null>(null);
const wfStopBusy = ref(false);
const wfProgress = ref<WfProgressItem[]>([]);
const wfError = ref("");
const wfAnalysisMode = ref(true);

const editingDraftId = ref<string | null>(null);

const taskModalOpen = ref(false);
const taskModalLoading = ref(false);
const taskModalPublishLoading = ref(false);
const taskModalInitial = ref<{
  title?: string;
  description?: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  devNotes?: string;
  includeDevNotes?: boolean;
  milestone?: string;
  requirementId?: string;
  gitlabIid?: number | null;
  gitlabUrl?: string | null;
}>({});

let disconnectRealtime: (() => void) | undefined;

const selected = computed(() =>
  requirements.value.find((r) => r.id === selectedId.value) || null,
);

const stepContent = (key: BaWorkflowStepKey) =>
  selected.value?.steps.find((s) => s.key === key)?.content || "";

/** Bỏ JSON gate/task ở cuối — chỉ hiện nội dung đọc được. */
function stepDisplayBody(key: BaWorkflowStepKey): string {
  const raw = stepContent(key).trim();
  if (!raw) return "";
  return raw
    .replace(/```json[\s\S]*?```/gi, "")
    .replace(/\{[\s\S]*"(?:gate|task|tasks)"\s*:[\s\S]*\}\s*$/m, "")
    .trim();
}

const stepDone = (key: BaWorkflowStepKey) => Boolean(stepContent(key));

const hasAnalysis = computed(() =>
  Boolean(selected.value?.steps.some((s) => s.content?.trim())),
);

const inputStale = computed(() => Boolean(selected.value?.inputStale));

const flowBlockedReason = computed(() => {
  if (!selectedId.value) return "Chọn YC";
  if (!ba.projectReady) return "Project chưa sẵn sàng";
  if (flowRunning.value) return "Flow đang chạy…";
  if (wfStreaming.value) return "Agent chat đang trả lời…";
  return "";
});

const runFlowLabel = computed(() => {
  if (flowRunning.value) return "Đang chạy…";
  if (flowPaused.value) return "Tiếp tục flow";
  if (inputStale.value && hasAnalysis.value) return "Phân tích lại";
  if (hasAnalysis.value) return "Chạy lại flow";
  return "Run flow";
});

const canRunFlow = computed(() => !flowBlockedReason.value);

const wfProgressLabel = computed(() => {
  const last = wfProgress.value[wfProgress.value.length - 1];
  return last?.label || (wfStreaming.value ? "Đang xử lý…" : "");
});

const composerDisabled = computed(
  () =>
    !wfThreadId.value ||
    !ba.projectReady ||
    wfStreaming.value ||
    flowRunning.value,
);

function isMyEvent(userId: string) {
  const me = session.session.username?.toLowerCase();
  return !me || userId.toLowerCase() === me;
}

function clearWfProgress() {
  wfProgress.value = [];
}

function applyWfMessage(ev: RealtimeBaMessage) {
  if (!isMyEvent(ev.userId)) return;
  if (ev.threadId !== wfThreadId.value) return;
  const idx = wfMessages.value.findIndex((m) => m.id === ev.message.id);
  if (idx >= 0) {
    const prev = wfMessages.value[idx];
    if (!ev.message.content && prev.content) {
      wfStreamingMessageId.value = ev.message.id;
      wfStreaming.value = true;
      return;
    }
    wfMessages.value[idx] = ev.message;
  } else {
    wfMessages.value.push(ev.message);
  }
  if (ev.message.role === "assistant" && !ev.message.content) {
    wfStreamingMessageId.value = ev.message.id;
    wfStreaming.value = true;
  }
}

function applyWfDone(ev: RealtimeBaDone) {
  if (!isMyEvent(ev.userId)) return;
  if (ev.threadId !== wfThreadId.value) return;
  const idx = wfMessages.value.findIndex((m) => m.id === ev.messageId);
  if (idx >= 0) {
    wfMessages.value[idx] = {
      ...wfMessages.value[idx],
      content: ev.content || wfMessages.value[idx].content,
    };
  } else if (ev.content) {
    wfMessages.value.push({
      id: ev.messageId,
      threadId: ev.threadId,
      role: "assistant",
      content: ev.content,
      createdAt: new Date().toISOString(),
    });
  }
  wfStreaming.value = false;
  wfStreamingMessageId.value = null;
  wfError.value = "";
  window.setTimeout(() => {
    if (!wfStreaming.value) clearWfProgress();
  }, 1200);
}

function applyWfError(ev: RealtimeBaError) {
  if (!isMyEvent(ev.userId)) return;
  if (ev.threadId !== wfThreadId.value) return;
  wfError.value = ev.error;
  wfStreaming.value = false;
  wfStreamingMessageId.value = null;
}

function applyWfProgress(ev: RealtimeBaProgress) {
  if (!isMyEvent(ev.userId)) return;
  if (ev.threadId !== wfThreadId.value) return;
  const item: WfProgressItem = {
    step: ev.step,
    label: ev.label,
    detail: ev.detail,
    at: new Date().toISOString(),
  };
  const idx = wfProgress.value.findIndex((p) => p.step === ev.step);
  if (idx >= 0) wfProgress.value[idx] = item;
  else wfProgress.value = [...wfProgress.value, item];
}

function applyWfStepProgress(ev: RealtimeBaWfStepProgress) {
  if (!isMyEvent(ev.userId)) return;
  if (selectedId.value && ev.requirementId !== selectedId.value) return;
  flowStepLabel.value = ev.label;
}

function applyWfStepDone(ev: RealtimeBaWfStepDone) {
  if (!isMyEvent(ev.userId)) return;
  // Chat workflow có thể cập nhật Kết quả phân tích không qua Run flow
  // (không có waiter) → đồng bộ trực tiếp vào view.
  if (ev.requirementId === selectedId.value) {
    syncRequirement({ requirement: ev.requirement, taskDrafts: ev.taskDrafts });
  }
  settleWfStepDone(ev);
}

function applyWfStepError(ev: RealtimeBaWfStepError) {
  if (!isMyEvent(ev.userId)) return;
  settleWfStepError(ev);
}

async function loadRequirements() {
  if (!ba.selectedProjectId) {
    requirements.value = [];
    selectedId.value = null;
    taskDrafts.value = [];
    wfThreadId.value = null;
    wfMessages.value = [];
    return;
  }
  const res = await baApi.listRequirements(ba.selectedProjectId);
  requirements.value = res.requirements || [];
  if (
    selectedId.value &&
    !requirements.value.some((r) => r.id === selectedId.value)
  ) {
    selectedId.value = null;
    taskDrafts.value = [];
    wfThreadId.value = null;
    wfMessages.value = [];
  }
}

async function loadWfMessages() {
  if (!wfThreadId.value) {
    wfMessages.value = [];
    return;
  }
  const res = await api<{ messages?: WfMessage[] }>(
    API.ba.messages(wfThreadId.value),
  );
  wfMessages.value = res.messages || [];
  wfStreaming.value = false;
  wfStreamingMessageId.value = null;
}

async function ensureThreadForSelected() {
  if (!selectedId.value) {
    wfThreadId.value = null;
    wfMessages.value = [];
    return;
  }
  const res = await baApi.ensureRequirementThread(selectedId.value);
  wfThreadId.value = res.threadId;
  const idx = requirements.value.findIndex((r) => r.id === selectedId.value);
  if (idx >= 0) requirements.value[idx] = res.requirement;
  await loadWfMessages();
}

async function loadDetail(id: string) {
  const res = await baApi.getRequirement(id);
  selectedId.value = id;
  const idx = requirements.value.findIndex((r) => r.id === id);
  if (idx >= 0) requirements.value[idx] = res.requirement;
  taskDrafts.value = res.taskDrafts || [];
  if (taskDrafts.value.length > 1) {
    taskDrafts.value = [taskDrafts.value[0]];
  }
  flowPaused.value = false;
  flowPauseReason.value = "";
  flowInvalidReason.value = "";
  editingYc.value = false;
  await ensureThreadForSelected();
}

async function refreshAll() {
  loading.value = true;
  try {
    await loadRequirements();
    if (selectedId.value) await loadDetail(selectedId.value);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function syncRequirement(res: {
  requirement: BaRequirement;
  taskDrafts?: BaTaskDraft[];
}) {
  const idx = requirements.value.findIndex((r) => r.id === res.requirement.id);
  if (idx >= 0) requirements.value[idx] = res.requirement;
  if (res.taskDrafts?.length) {
    taskDrafts.value = res.taskDrafts;
  }
}

async function runFlow(fromIndex = 0) {
  if (!selectedId.value || !canRunFlow.value) return;
  const requirementId = selectedId.value;
  flowRunning.value = true;
  flowPaused.value = false;
  flowPauseReason.value = "";
  flowInvalidReason.value = "";
  flowAbort.value = false;
  try {
    await ensureThreadForSelected();
    for (let i = fromIndex; i < WORKFLOW_STEP_ORDER.length; i++) {
      if (flowAbort.value) {
        message.info("Đã dừng flow");
        break;
      }
      const step = WORKFLOW_STEP_ORDER[i];
      activeFlowStep.value = step;
      flowResumeFrom.value = i;
      flowStepLabel.value =
        WORKFLOW_STEPS.find((s) => s.key === step)?.label || step;

      await baApi.runWorkflowStep(requirementId, step);
      const res = await waitForWorkflowStep(requirementId, step);
      syncRequirement(res);
      flowStepLabel.value = "";

      if (step === "clarify" && res.gate?.status === "invalid") {
        flowInvalidReason.value =
          res.gate.openQuestions.join("\n") ||
          "Yêu cầu gốc không phải nội dung nghiệp vụ — sửa lại YC rồi chạy lại.";
        activeFlowStep.value = null;
        message.error("Flow dừng — YC chưa phải một yêu cầu nghiệp vụ");
        return;
      }

      // blocked: chỉ ghi chú câu hỏi — không pause flow (ưu tiên giả định, chạy tiếp).
      if (
        step === "clarify" &&
        res.gate?.status === "blocked" &&
        res.gate.openQuestions.length
      ) {
        flowPauseReason.value = res.gate.openQuestions.join("\n");
        message.info(
          "Bước 1 còn điểm cần chốt (giả định) — flow vẫn chạy tiếp Hiện trạng",
        );
      }
    }
    if (!flowAbort.value) {
      message.success("Hoàn thành flow — xem Kết quả phân tích bên dưới");
    }
    activeFlowStep.value = null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (flowAbort.value || /đã dừng|force-stopped|force.stopped/i.test(msg)) {
      message.info("Đã dừng flow");
    } else {
      message.error(msg);
    }
  } finally {
    flowRunning.value = false;
    flowStepLabel.value = "";
    if (!flowPaused.value) activeFlowStep.value = null;
  }
}

function stopFlow() {
  if (!flowRunning.value) return;
  flowAbort.value = true;
  clearWfStepWaiters("Đã dừng flow");
  const id = selectedId.value;
  if (id) {
    void baApi.stopWorkflow(id).catch(() => undefined);
  }
}

function continueFlow() {
  if (!selectedId.value || flowRunning.value) return;
  // Sau khi pause ở clarify: nhảy sang bước kế (Hiện trạng), không chạy lại
  // clarify — BA đã xem câu hỏi / giả định, muốn đi tiếp.
  const from = flowPaused.value
    ? Math.min(flowResumeFrom.value + 1, WORKFLOW_STEP_ORDER.length - 1)
    : 0;
  flowPaused.value = false;
  void runFlow(from);
}

async function createYc() {
  const rawContent = ycContent.value.trim();
  if (!rawContent) {
    message.warning("Dán yêu cầu gốc từ khách hàng / PD trước");
    return;
  }
  if (!ba.selectedProjectId) {
    message.warning("Chọn project ở thanh trên cùng trước");
    return;
  }
  loading.value = true;
  try {
    const res = await baApi.createRequirement({
      baProjectId: ba.selectedProjectId,
      title: ycTitle.value.trim() || undefined,
      rawContent,
      baNote: ycBaNote.value.trim() || undefined,
    });
    ycTitle.value = "";
    ycContent.value = "";
    ycBaNote.value = "";
    requirements.value = [res.requirement, ...requirements.value];
    await loadDetail(res.requirement.id);
    message.success("Đã tạo YC — bấm Run flow để phân tích");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function startEditYc() {
  if (!selected.value) return;
  editYcTitle.value = selected.value.title;
  editYcContent.value = selected.value.rawContent;
  editYcBaNote.value = selected.value.baNote || "";
  editingYc.value = true;
}

async function saveYcEdit() {
  if (!selected.value) return;
  const rawContent = editYcContent.value.trim();
  if (!rawContent) {
    message.warning("Yêu cầu gốc không được để trống");
    return;
  }
  editYcSaving.value = true;
  try {
    const res = await baApi.updateRequirement(selected.value.id, {
      title: editYcTitle.value.trim() || undefined,
      rawContent,
      baNote: editYcBaNote.value.trim() || null,
    });
    syncRequirement({ requirement: res.requirement });
    editingYc.value = false;
    flowInvalidReason.value = "";
    if (res.requirement.inputStale) {
      message.info("YC đã đổi — bấm Phân tích lại để cập nhật kết quả");
    } else {
      message.success("Đã lưu YC");
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    editYcSaving.value = false;
  }
}

function onDeleteYc(id: string, title: string) {
  Modal.confirm({
    title: "Xóa YC?",
    content: title,
    okType: "danger",
    okText: "Xóa",
    cancelText: "Huỷ",
    onOk: async () => {
      await baApi.deleteRequirement(id);
      requirements.value = requirements.value.filter((r) => r.id !== id);
      if (selectedId.value === id) {
        selectedId.value = null;
        taskDrafts.value = [];
        wfThreadId.value = null;
        wfMessages.value = [];
      }
      message.success("Đã xóa");
    },
  });
}

async function onWfSend(content: string) {
  if (!wfThreadId.value) return;
  wfError.value = "";
  try {
    await api(API.ba.messages(wfThreadId.value), {
      method: "POST",
      body: JSON.stringify({
        content,
        analysisMode: wfAnalysisMode.value,
      }),
    });
    wfStreaming.value = true;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onWfStop() {
  if (!wfThreadId.value) return;
  wfStopBusy.value = true;
  try {
    await api(API.ba.stop(wfThreadId.value), { method: "POST" });
    message.info("Đã gửi lệnh dừng");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    wfStopBusy.value = false;
  }
}

function openTaskFromDraft(draft: BaTaskDraft) {
  editingDraftId.value = draft.id;
  taskModalInitial.value = {
    title: draft.title,
    description: draft.description,
    labels: draft.labels,
    acceptanceCriteria: draft.acceptanceCriteria,
    devNotes: draft.devNotes || undefined,
    includeDevNotes: Boolean(draft.includeDevNotes),
    milestone: draft.milestone || undefined,
    requirementId: draft.requirementId || selectedId.value || undefined,
    gitlabIid: draft.gitlabIid ?? null,
    gitlabUrl: draft.gitlabUrl ?? null,
  };
  taskModalOpen.value = true;
}

async function onTaskSave(payload: {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  devNotes?: string;
  includeDevNotes: boolean;
  milestone?: string;
  assignee?: string;
  requirementId?: string;
}) {
  if (!editingDraftId.value) return;
  taskModalLoading.value = true;
  try {
    const res = await baApi.updateTaskDraft(editingDraftId.value, {
      title: payload.title,
      description: payload.description,
      labels: payload.labels,
      acceptanceCriteria: payload.acceptanceCriteria,
      devNotes: payload.devNotes ?? null,
      includeDevNotes: payload.includeDevNotes,
      milestone: payload.milestone ?? null,
    });
    const idx = taskDrafts.value.findIndex((d) => d.id === editingDraftId.value);
    if (idx >= 0) taskDrafts.value[idx] = res.taskDraft;
    taskModalOpen.value = false;
    message.success("Đã cập nhật draft");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    taskModalLoading.value = false;
  }
}

async function doTaskPublish(payload: {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  devNotes?: string;
  includeDevNotes: boolean;
  milestone: string;
  assignee?: string;
  requirementId?: string;
  mode?: "update" | "new";
}) {
  if (!ba.selectedProjectId) return;
  taskModalPublishLoading.value = true;
  try {
    const draftId = editingDraftId.value;
    if (!draftId) {
      message.error("Không tìm thấy draft");
      return;
    }
    await baApi.updateTaskDraft(draftId, {
      title: payload.title,
      description: payload.description,
      labels: payload.labels,
      acceptanceCriteria: payload.acceptanceCriteria,
      devNotes: payload.devNotes ?? null,
      includeDevNotes: payload.includeDevNotes,
      milestone: payload.milestone,
    });
    const pub = await baApi.publishTaskDraft(draftId, {
      assignee: payload.assignee,
      milestone: payload.milestone,
      mode: payload.mode,
      includeDevNotes: payload.includeDevNotes,
    });
    const idx = taskDrafts.value.findIndex((d) => d.id === draftId);
    if (idx >= 0) taskDrafts.value[idx] = pub.taskDraft;
    taskModalOpen.value = false;
    message.success(
      pub.mode === "update"
        ? `Đã cập nhật task GitLab #${pub.issue.iid}`
        : `Đã lên GitLab #${pub.issue.iid}`,
    );
  } catch (e) {
    if (!handleBaPatApiError(e, () => void doTaskPublish(payload))) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  } finally {
    taskModalPublishLoading.value = false;
  }
}

function onTaskPublish(payload: {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  devNotes?: string;
  includeDevNotes: boolean;
  milestone: string;
  assignee?: string;
  requirementId?: string;
  mode?: "update" | "new";
}) {
  if (!requireGitPat(() => void doTaskPublish(payload))) return;
  void doTaskPublish(payload);
}

watch(
  () => ba.selectedProjectId,
  () => void refreshAll(),
);

onMounted(() => {
  disconnectRealtime = connectRealtime({
    onBaMessage: applyWfMessage,
    onBaDone: applyWfDone,
    onBaError: applyWfError,
    onBaProgress: applyWfProgress,
    onBaWfStepProgress: applyWfStepProgress,
    onBaWfStepDone: applyWfStepDone,
    onBaWfStepError: applyWfStepError,
  });
  void refreshAll();
});

onUnmounted(() => {
  clearWfStepWaiters();
  disconnectRealtime?.();
});
</script>

<template>
  <div class="faw-ba-workflow h-full min-h-0 flex flex-col overflow-hidden">
    <div class="hidden lg:flex flex-1 min-h-0">
      <Splitpanes
        class="work-split faw-split default-theme flex-1 min-h-0"
        @resized="panes.onResized"
      >
        <!-- Cột 1: danh sách YC -->
        <Pane :size="panes.leftSize" :min-size="16" :max-size="36">
          <aside class="faw-col h-full flex flex-col min-h-0 border-r border-[var(--app-border)]">
            <div class="faw-col-head">
              <h2>YC</h2>
              <span class="faw-count">{{ requirements.length }}</span>
            </div>
            <div class="faw-filters p-3 space-y-2 border-b border-[var(--app-border)]">
              <a-input
                v-model:value="ycTitle"
                size="small"
                placeholder="Tiêu đề (tùy chọn)"
              />
              <div>
                <label class="faw-ba-label block mb-1">Yêu cầu gốc (khách hàng / PD) *</label>
                <a-textarea
                  v-model:value="ycContent"
                  :rows="3"
                  placeholder="Dán yêu cầu từ KH/PD. Có thể kèm #123, link GitLab, Google Docs/Sheets/Excel Drive…"
                />
                <p class="text-[11px] text-[var(--app-muted)] m-0 mt-1">
                  Hệ thống tự đọc #issue / link GitLab (PAT project) và Google Docs–Sheets–Excel Drive (Settings → Authorize Google).
                </p>
              </div>
              <div>
                <label class="faw-ba-label block mb-1">BA phân tích / đàm phán (tùy chọn)</label>
                <a-textarea
                  v-model:value="ycBaNote"
                  :rows="2"
                  placeholder="Điểm BA đã đàm phán / điều chỉnh so với yêu cầu gốc…"
                />
              </div>
              <button
                type="button"
                class="faw-btn faw-btn--run w-full"
                :disabled="!ba.projectReady || loading"
                @click="createYc"
              >
                <PlusOutlined /> Tạo YC
              </button>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto">
              <button
                v-for="r in requirements"
                :key="r.id"
                type="button"
                class="faw-ba-thread w-full text-left"
                :class="{ active: r.id === selectedId }"
                @click="loadDetail(r.id)"
              >
                <div class="faw-ba-thread__main min-w-0">
                  <span class="faw-ba-thread__title truncate">{{ r.title }}</span>
                  <span class="faw-ba-thread__time">{{ r.status }}</span>
                </div>
                <button
                  type="button"
                  class="faw-icon-btn faw-ba-thread__del shrink-0"
                  @click.stop="onDeleteYc(r.id, r.title)"
                >
                  <DeleteOutlined />
                </button>
              </button>
            </div>
          </aside>
        </Pane>

        <!-- Cột 2: flow + kết quả bước -->
        <Pane :size="panes.midSize" :min-size="28">
          <section class="h-full min-h-0 flex flex-col overflow-hidden bg-[var(--app-bg)]">
            <div v-if="!selected" class="flex-1 flex items-center justify-center p-6">
              <a-empty description="Chọn hoặc tạo YC — bấm Run flow để chạy 4 bước tự động" />
            </div>

            <template v-else>
              <div class="faw-console-head shrink-0">
                <div class="faw-console-head__title min-w-0">
                  <h2 class="truncate">{{ selected.title }}</h2>
                  <div class="faw-console-head__win">
                    {{ selected.status }}
                    <template v-if="activeFlowStep">
                      · {{ flowStepLabel || WORKFLOW_STEPS.find((s) => s.key === activeFlowStep)?.label }}
                    </template>
                    <template v-else-if="flowPaused"> · chờ làm rõ</template>
                  </div>
                </div>
                <div class="faw-console-actions flex gap-2 shrink-0">
                  <a-tooltip :title="flowBlockedReason || undefined">
                    <button
                      type="button"
                      class="faw-btn faw-btn--run"
                      :disabled="!canRunFlow && !flowPaused"
                      @click="flowPaused ? continueFlow() : runFlow(0)"
                    >
                      {{ runFlowLabel }}
                    </button>
                  </a-tooltip>
                  <button
                    v-if="flowRunning"
                    type="button"
                    class="faw-btn"
                    @click="stopFlow"
                  >
                    Dừng
                  </button>
                </div>
              </div>

              <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                <a-alert
                  v-if="flowInvalidReason"
                  type="error"
                  show-icon
                  class="text-[12px]"
                >
                  <template #message>Flow dừng — YC không phải yêu cầu nghiệp vụ</template>
                  <template #description>
                    <p class="m-0 whitespace-pre-wrap">{{ flowInvalidReason }}</p>
                    <p class="m-0 mt-2 text-[11px] text-[var(--app-muted)]">
                      Sửa lại <strong>Yêu cầu gốc</strong> (ai cần gì, để làm gì) rồi chạy lại.
                    </p>
                  </template>
                </a-alert>

                <a-alert
                  v-if="inputStale && hasAnalysis && !flowRunning"
                  type="info"
                  show-icon
                  class="text-[12px]"
                >
                  <template #message>YC gốc / BA đàm phán đã thay đổi</template>
                  <template #description>
                    <p class="m-0">
                      Kết quả bên dưới dựa trên bản cũ. Bấm
                      <strong>Phân tích lại</strong> — agent sẽ đọc cả trao đổi
                      chat đã có để phân tích tự nhiên, không làm lại từ đầu.
                    </p>
                  </template>
                </a-alert>

                <a-alert
                  v-if="flowPaused"
                  type="warning"
                  show-icon
                  class="text-[12px]"
                >
                  <template #message>Bước 1 còn điểm cần chốt — có thể chạy tiếp với giả định</template>
                  <template #description>
                    <p class="m-0 whitespace-pre-wrap">{{ flowPauseReason }}</p>
                    <p class="m-0 mt-2 text-[11px] text-[var(--app-muted)]">
                      Trao đổi chat bên phải nếu muốn chốt, hoặc bấm
                      <strong>Tiếp tục flow</strong> để sang Hiện trạng (câu hỏi sẽ mang theo như giả định).
                    </p>
                  </template>
                </a-alert>

                <a-card size="small">
                  <template #title>Yêu cầu gốc (khách hàng / PD)</template>
                  <template #extra>
                    <button
                      v-if="!editingYc"
                      type="button"
                      class="faw-btn text-[11px]"
                      :disabled="flowRunning"
                      @click="startEditYc"
                    >
                      Sửa
                    </button>
                  </template>

                  <template v-if="!editingYc">
                    <pre class="whitespace-pre-wrap text-[12px] m-0 font-sans">{{ selected.rawContent }}</pre>
                    <div
                      v-if="selected.baNote"
                      class="mt-3 pt-2 border-t border-dashed border-[var(--app-border)]"
                    >
                      <div class="text-[11px] font-semibold text-[var(--app-muted)] mb-1">
                        BA phân tích / đàm phán
                      </div>
                      <pre class="whitespace-pre-wrap text-[12px] m-0 font-sans">{{ selected.baNote }}</pre>
                    </div>
                  </template>

                  <div v-else class="space-y-2">
                    <a-input
                      v-model:value="editYcTitle"
                      size="small"
                      placeholder="Tiêu đề"
                    />
                    <div>
                      <label class="faw-ba-label block mb-1">Yêu cầu gốc *</label>
                      <a-textarea v-model:value="editYcContent" :rows="4" />
                    </div>
                    <div>
                      <label class="faw-ba-label block mb-1">BA phân tích / đàm phán</label>
                      <a-textarea v-model:value="editYcBaNote" :rows="3" />
                    </div>
                    <div class="flex gap-2 justify-end">
                      <button
                        type="button"
                        class="faw-btn text-[11px]"
                        @click="editingYc = false"
                      >
                        Huỷ
                      </button>
                      <button
                        type="button"
                        class="faw-btn faw-btn--run text-[11px]"
                        :disabled="editYcSaving"
                        @click="saveYcEdit"
                      >
                        {{ editYcSaving ? "…" : "Lưu YC" }}
                      </button>
                    </div>
                  </div>
                </a-card>

                <div class="space-y-3">
                  <div
                    v-for="step in WORKFLOW_STEPS"
                    :key="step.key"
                    class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3"
                    :class="{
                      'ring-1 ring-[var(--app-accent)]': activeFlowStep === step.key,
                    }"
                  >
                    <div class="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div class="text-[13px] font-semibold text-[var(--app-ink)]">
                          {{ step.label }}
                        </div>
                        <div class="text-[11px] text-[var(--app-muted)]">{{ step.hint }}</div>
                      </div>
                      <span
                        class="text-[10px] uppercase tracking-wide shrink-0"
                        :class="
                          stepDone(step.key)
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-[var(--app-faint)]'
                        "
                      >
                        {{ stepDone(step.key) ? "Xong" : "Chưa chạy" }}
                      </span>
                    </div>
                    <div
                      v-if="stepDisplayBody(step.key)"
                      class="faw-ba-step-body max-h-[360px] overflow-y-auto border-t border-[var(--app-border)] pt-2 mt-2 text-[13px]"
                    >
                      <ChatMessageBody
                        :body="stepDisplayBody(step.key)"
                        markdown
                      />
                    </div>
                  </div>
                </div>

                <a-card
                  v-if="taskDraft"
                  size="small"
                  class="ring-1 ring-[var(--app-accent)]"
                >
                  <template #title>
                    Kết quả phân tích — trọng tâm (chỉnh tiếp qua chat bên phải)
                  </template>
                  <template #extra>
                    <button
                      type="button"
                      class="faw-btn faw-btn--run text-[11px]"
                      @click="openTaskFromDraft(taskDraft)"
                    >
                      {{ taskDraft.gitlabIid ? "Cập nhật / tạo task" : "Tạo task" }}
                    </button>
                  </template>

                  <div class="space-y-2">
                    <div class="font-semibold text-[13px]">
                      {{ taskDraft.title }}
                    </div>
                    <div class="text-[11px] text-[var(--app-muted)]">
                      {{ taskDraft.status }}
                      <a
                        v-if="taskDraft.gitlabUrl"
                        :href="taskDraft.gitlabUrl"
                        target="_blank"
                        rel="noopener"
                        class="ml-1"
                      >
                        · GitLab #{{ taskDraft.gitlabIid }}
                      </a>
                    </div>
                    <div
                      v-if="taskDraft.description"
                      class="faw-ba-step-body max-h-[320px] overflow-y-auto border-t border-[var(--app-border)] pt-2 text-[13px]"
                    >
                      <ChatMessageBody :body="taskDraft.description" markdown />
                    </div>
                    <ul
                      v-if="taskDraft.acceptanceCriteria.length"
                      class="m-0 pl-4 text-[12px] space-y-0.5"
                    >
                      <li v-for="(ac, i) in taskDraft.acceptanceCriteria" :key="i">
                        {{ ac }}
                      </li>
                    </ul>

                    <details
                      v-if="taskDraft.devNotes"
                      class="rounded-lg border border-dashed border-[var(--app-border)] px-3 py-2"
                    >
                      <summary class="cursor-pointer text-[12px] font-medium text-[var(--app-muted)]">
                        Ghi chú kỹ thuật cho Dev (lưu riêng —
                        {{ taskDraft.includeDevNotes ? "sẽ đưa lên task" : "không đưa lên task" }})
                      </summary>
                      <div class="faw-ba-step-body mt-2 text-[12px]">
                        <ChatMessageBody :body="taskDraft.devNotes" markdown />
                      </div>
                    </details>
                  </div>
                </a-card>
              </div>
            </template>
          </section>
        </Pane>

        <!-- Cột 3: chat workflow (tương tự dev console) -->
        <Pane :size="panes.rightSize" :min-size="24">
          <section class="faw-console h-full min-h-0 flex flex-col border-l border-[var(--app-border)]">
            <div class="faw-console-head shrink-0">
              <div class="faw-console-head__title min-w-0">
                <h2>Chat workflow</h2>
                <div class="faw-console-head__win">
                  Làm rõ YC — nội dung chat được dùng khi chạy / chạy lại flow
                </div>
              </div>
              <span v-if="wfStreaming" class="faw-idle text-[11px] shrink-0">
                <span class="faw-idle__dot wip" />
                {{ wfProgressLabel || "Streaming" }}
              </span>
            </div>

            <div v-if="!selected" class="flex-1 flex items-center justify-center p-4">
              <p class="text-[12px] text-[var(--app-muted)] m-0 text-center">
                Chọn YC để mở chat làm rõ
              </p>
            </div>

            <template v-else>
              <BaMessageList
                :messages="wfMessages"
                :streaming="wfStreaming"
                :streaming-message-id="wfStreamingMessageId"
                :progress-hint="wfProgressLabel"
              />
              <div v-if="wfError" class="shrink-0 px-3 pb-1">
                <a-alert type="error" show-icon :message="wfError" />
              </div>
              <BaComposer
                :disabled="composerDisabled"
                :disabled-reason="
                  !wfThreadId
                    ? 'Đang tải chat…'
                    : flowRunning
                      ? 'Đợi flow xong'
                      : 'Không gửi được'
                "
                :loading="wfStreaming"
                :stop-busy="wfStopBusy"
                :analysis-mode="wfAnalysisMode"
                @update:analysis-mode="wfAnalysisMode = $event"
                @send="onWfSend"
                @stop="onWfStop"
              />
            </template>
          </section>
        </Pane>
      </Splitpanes>
    </div>

    <!-- Mobile: stack đơn giản -->
    <div class="lg:hidden flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
      <a-empty v-if="!selected" description="Chọn YC trên desktop layout" />
      <template v-else>
        <button
          type="button"
          class="faw-btn faw-btn--run w-full"
          :disabled="!canRunFlow && !flowPaused"
          @click="flowPaused ? continueFlow() : runFlow(0)"
        >
          {{ runFlowLabel }}
        </button>
        <p class="text-[12px] text-[var(--app-muted)] m-0">
          Mở màn hình rộng để xem layout 3 cột đầy đủ.
        </p>
      </template>
    </div>

    <BaTaskFormModal
      v-model:open="taskModalOpen"
      :ba-project-id="ba.selectedProjectId || ''"
      :initial="taskModalInitial"
      :loading="taskModalLoading"
      :publish-loading="taskModalPublishLoading"
      @save="onTaskSave"
      @publish="onTaskPublish"
    />
  </div>
</template>
