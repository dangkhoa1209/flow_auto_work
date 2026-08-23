<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { useBaChatStore } from "@/stores/baChat";
import { baApi } from "@/api/baApi";
import { useBaGitPat } from "@/composables/useBaGitPat";
import BaChatSidebar from "@/components/ba/BaChatSidebar.vue";
import BaMessageList from "@/components/ba/BaMessageList.vue";
import BaComposer from "@/components/ba/BaComposer.vue";
import BaProgressRail from "@/components/ba/BaProgressRail.vue";
import BaTaskFormModal from "@/components/ba/BaTaskFormModal.vue";

const ba = useBaChatStore();
const { requireGitPat, handleBaPatApiError } = useBaGitPat();

const taskModalOpen = ref(false);
const taskModalLoading = ref(false);
const taskModalPublishLoading = ref(false);
const taskModalInitial = ref<{
  title?: string;
  description?: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  milestone?: string;
  assignee?: string;
  threadId?: string;
  messageId?: string;
}>({});

const draftingIssue = computed(
  () =>
    ba.issueDrafting && ba.issueDraftThreadId === ba.activeThreadId,
);

const composerDisabled = computed(() => {
  if (!ba.selectedProjectId) return true;
  if (!ba.projectReady) return true;
  if (ba.streaming) return true;
  return false;
});

const disabledReason = computed(() => {
  if (!ba.selectedProjectId) return "Chọn project ở sidebar";
  if (!ba.projectReady) return "Project chưa sẵn sàng — liên hệ admin";
  if (ba.streaming) return "Đang trả lời…";
  return "";
});

/** Feature flag từ admin: hide ẩn nút, lab hiện kèm nhãn. */
const createIssueVisible = computed(() => ba.featureVisible("createIssue"));
const createIssueLabel = computed(() =>
  ba.featureLabel("createIssue", "Create issue"),
);

const createIssueDisabled = computed(() => {
  if (draftingIssue.value) return true;
  if (!ba.activeThreadId) return true;
  if (!ba.selectedProjectId || !ba.projectReady) return true;
  if (ba.streaming) return true;
  if (!ba.messages.some((m) => m.content?.trim())) return true;
  return false;
});

const createIssueDisabledReason = computed(() => {
  if (draftingIssue.value) {
    return ba.issueDraftLabel || "Agent đang tổng hợp issue…";
  }
  if (!ba.activeThreadId) return "Chọn hoặc tạo cuộc chat";
  if (!ba.selectedProjectId) return "Chọn project ở sidebar";
  if (!ba.projectReady) return "Project chưa sẵn sàng";
  if (ba.streaming) return "Đợi agent trả lời xong";
  if (!ba.messages.some((m) => m.content?.trim())) return "Chưa có hội thoại";
  return "";
});

watch(
  () => ba.issueDraftResult,
  (res) => {
    if (!res) return;
    if (res.threadId !== ba.activeThreadId) return;
    taskModalInitial.value = {
      ...res.draft,
      threadId: res.threadId,
    };
    taskModalOpen.value = true;
    message.success(
      res.cached
        ? "Dùng bản soạn trước — chat chưa thay đổi"
        : "Đã soạn draft — chỉnh sửa rồi lưu hoặc publish",
    );
  },
);

watch(
  () => ba.issueDraftError,
  (err) => {
    if (!err) return;
    if (
      ba.issueDraftThreadId &&
      ba.issueDraftThreadId !== ba.activeThreadId
    ) {
      return;
    }
    message.error(err);
    if (!taskModalInitial.value.title) {
      taskModalOpen.value = false;
    }
  },
);

async function onSend(content: string) {
  try {
    await ba.sendMessage(content);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onStop() {
  try {
    await ba.stop();
    message.info("Đã gửi lệnh dừng");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

function applyReadyDraft(res: {
  draft?: {
    title: string;
    description: string;
    labels: string[];
    acceptanceCriteria: string[];
  };
  threadId: string;
  cached?: boolean;
}) {
  if (!res.draft) return;
  taskModalInitial.value = {
    ...res.draft,
    threadId: res.threadId,
  };
  taskModalOpen.value = true;
  ba.clearIssueDraft();
  message.success(
    res.cached
      ? "Dùng bản soạn trước — chat chưa thay đổi"
      : "Đã soạn draft — chỉnh sửa rồi lưu hoặc publish",
  );
}

async function runCreateIssueFromThread() {
  if (!ba.activeThreadId || createIssueDisabled.value) return;
  const threadId = ba.activeThreadId;
  ba.beginIssueDraft(threadId);
  taskModalInitial.value = { threadId };
  taskModalOpen.value = true;
  try {
    const res = await baApi.draftIssueFromThread(threadId);
    if (res.status === "ready" && res.draft) {
      applyReadyDraft(res);
      return;
    }
    // status === "started" → chờ SSE ba_issue_draft_done
  } catch (e) {
    ba.clearIssueDraft();
    taskModalOpen.value = false;
    if (!handleBaPatApiError(e, () => void runCreateIssueFromThread())) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }
}

function onCreateIssueFromThread() {
  if (createIssueDisabled.value) return;
  if (!requireGitPat(() => void runCreateIssueFromThread())) return;
  void runCreateIssueFromThread();
}

function onTaskModalClose(open: boolean) {
  taskModalOpen.value = open;
  if (!open && !ba.issueDrafting) {
    ba.clearIssueDraft();
  }
}

async function onTaskSave(payload: {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  milestone?: string;
  assignee?: string;
  threadId?: string;
  messageId?: string;
}) {
  if (!ba.selectedProjectId) return;
  taskModalLoading.value = true;
  try {
    await baApi.createTaskDraft({
      baProjectId: ba.selectedProjectId,
      ...payload,
    });
    taskModalOpen.value = false;
    ba.clearIssueDraft();
    message.success("Đã lưu task draft — xem tab Tasks");
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
  milestone: string;
  assignee?: string;
  threadId?: string;
  messageId?: string;
}) {
  if (!ba.selectedProjectId) return;
  taskModalPublishLoading.value = true;
  try {
    const created = await baApi.createTaskDraft({
      baProjectId: ba.selectedProjectId,
      title: payload.title,
      description: payload.description,
      labels: payload.labels,
      acceptanceCriteria: payload.acceptanceCriteria,
      milestone: payload.milestone,
      threadId: payload.threadId,
      messageId: payload.messageId,
    });
    const pub = await baApi.publishTaskDraft(created.taskDraft.id, {
      assignee: payload.assignee,
      milestone: payload.milestone,
    });
    taskModalOpen.value = false;
    ba.clearIssueDraft();
    message.success(`Đã lên GitLab #${pub.issue.iid}`);
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
  milestone: string;
  assignee?: string;
  threadId?: string;
  messageId?: string;
}) {
  if (!requireGitPat(() => void doTaskPublish(payload))) return;
  void doTaskPublish(payload);
}
</script>

<template>
  <div class="faw-ba h-full min-h-0 flex overflow-hidden">
    <BaChatSidebar />

    <section class="faw-console flex-1 min-w-0 min-h-0 flex flex-col">
      <div class="faw-console-head">
        <div class="faw-console-head__title">
          <h2>{{ ba.activeThread?.title || "Project Chat" }}</h2>
          <div class="faw-console-head__win">
            <template v-if="ba.selectedProject">
              {{ ba.selectedProject.displayName }}
              <template v-if="ba.selectedProject.gitlabPath">
                · {{ ba.selectedProject.gitlabPath }}
              </template>
            </template>
            <template v-else>Chưa chọn project</template>
          </div>
        </div>
        <div class="faw-console-actions">
          <a-tooltip
            v-if="createIssueVisible"
            :title="createIssueDisabledReason || undefined"
          >
            <button
              type="button"
              class="faw-btn faw-btn--run"
              :disabled="createIssueDisabled"
              @click="onCreateIssueFromThread"
            >
              {{ draftingIssue ? "Đang soạn…" : createIssueLabel }}
            </button>
          </a-tooltip>
          <span
            v-if="ba.analysisMode && !ba.streaming"
            class="faw-idle text-[11px]"
            title="BA mode: phân tích nghiệp vụ"
          >
            BA mode
          </span>
          <span
            v-if="ba.streaming"
            class="faw-idle text-[11px]"
          >
            <span class="faw-idle__dot wip" />
            {{ ba.currentProgressLabel || "Streaming" }}
          </span>
        </div>
      </div>

      <BaProgressRail />

      <div
        v-if="!ba.projects.length"
        class="flex-1 flex items-center justify-center px-6"
      >
        <a-empty description="Chưa có project — admin cần tạo và clone trước" />
      </div>

      <template v-else>
        <BaMessageList
          :messages="ba.messages"
          :streaming="ba.streaming"
          :streaming-message-id="ba.streamingMessageId"
          :progress-hint="ba.currentProgressLabel"
        />
        <div
          v-if="ba.errorText"
          class="shrink-0 px-3 pb-1"
        >
          <a-alert type="error" show-icon :message="ba.errorText" />
        </div>
        <BaComposer
          :disabled="composerDisabled"
          :disabled-reason="disabledReason"
          :loading="ba.streaming"
          :stop-busy="ba.stopBusy"
          :analysis-mode="ba.analysisMode"
          @update:analysis-mode="ba.setAnalysisMode($event)"
          @send="onSend"
          @stop="onStop"
        />
      </template>
    </section>

    <BaTaskFormModal
      :open="taskModalOpen"
      :ba-project-id="ba.selectedProjectId || ''"
      :initial="taskModalInitial"
      :loading="taskModalLoading"
      :publish-loading="taskModalPublishLoading"
      :agent-drafting="draftingIssue"
      :agent-draft-label="ba.issueDraftLabel"
      @update:open="onTaskModalClose"
      @save="onTaskSave"
      @publish="onTaskPublish"
    />
  </div>
</template>
