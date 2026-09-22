<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { useBaChatStore } from "@/stores/baChat";
import { baApi } from "@/api/baApi";
import { ApiError } from "@/api/http";
import { useBaGitPat } from "@/composables/useBaGitPat";
import BaChatSidebar from "@/components/ba/BaChatSidebar.vue";
import BaMessageList from "@/components/ba/BaMessageList.vue";
import BaComposer from "@/components/ba/BaComposer.vue";
import BaTaskFormModal from "@/components/ba/BaTaskFormModal.vue";

const ba = useBaChatStore();
const { requireGitPat, handleBaPatApiError } = useBaGitPat();

const composerRef = ref<{ fill: (prompt: string) => void } | null>(null);

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
  return false;
});

const disabledReason = computed(() => {
  if (!ba.selectedProjectId) return "Select a project in the top bar";
  if (!ba.projectReady) return "Project is not ready yet — ask an admin";
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
    return ba.issueDraftLabel || "Summarizing the conversation…";
  }
  if (!ba.activeThreadId) return "Select or start a chat";
  if (!ba.selectedProjectId) return "Select a project in the sidebar";
  if (!ba.projectReady) return "Project is not ready";
  if (ba.streaming) return "Wait for the agent to finish answering";
  if (!ba.messages.some((m) => m.content?.trim())) return "No conversation yet";
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
        ? "Using the previous draft — chat has not changed"
        : "Draft ready — edit, then save or publish",
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
    if (ba.streaming) {
      await ba.stop();
    }
    await ba.sendMessage(content);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onRetryFailed() {
  try {
    await ba.retryFailedSend();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onRegenerate(messageId: string) {
  try {
    await ba.regenerateMessage(messageId);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function onStop() {
  try {
    await ba.stop();
    message.info("Stop requested");
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
      ? "Using the previous draft — chat has not changed"
      : "Draft ready — edit, then save or publish",
  );
}

function isIssueDraftInFlightError(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) return false;
  const msg = e.message || "";
  return /still drafting the issue/i.test(msg);
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
    // status === "started" (incl. alreadyRunning) → wait for SSE ba_issue_draft_done
  } catch (e) {
    // Legacy 409 while draft agent still runs — keep modal, wait for SSE.
    if (isIssueDraftInFlightError(e)) {
      ba.beginIssueDraft(threadId);
      taskModalOpen.value = true;
      message.info("Issue is still drafting — wait in the modal");
      return;
    }
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
    message.success("Task draft saved — see the Tasks tab");
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
    message.success(`Published to GitLab #${pub.issue.iid}`);
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

function onUsePrompt(prompt: string) {
  composerRef.value?.fill(prompt);
}

const contextBits = computed(() => {
  const bits: { key: string; label: string; tone?: "accent" | "warn" }[] = [];
  if (ba.analysisMode) {
    bits.push({ key: "mode", label: "BA mode", tone: "accent" });
  }
  if (draftingIssue.value) {
    bits.push({
      key: "draft",
      label: ba.issueDraftLabel || "Drafting issue…",
      tone: "warn",
    });
  }
  return bits;
});
</script>

<template>
  <div class="faw-ba h-full min-h-0 flex overflow-hidden">
    <BaChatSidebar />

    <section class="faw-console faw-console--ba flex-1 min-w-0 min-h-0 flex flex-col">
      <div class="faw-console-head faw-console-head--ba">
        <div class="faw-console-head__title">
          <h2>{{ ba.activeThread?.title || "Project Chat" }}</h2>
          <div
            v-if="!ba.selectedProject"
            class="faw-console-head__win"
          >
            No project selected
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
              <span class="faw-ba-create-label faw-ba-create-label--full">{{
                draftingIssue ? "Drafting…" : createIssueLabel
              }}</span>
              <span class="faw-ba-create-label faw-ba-create-label--short">{{
                draftingIssue ? "…" : "Issue"
              }}</span>
            </button>
          </a-tooltip>
          <span
            v-if="ba.streaming"
            class="faw-idle text-[11px]"
          >
            <span class="faw-idle__dot wip" />
            thinking…
          </span>
        </div>
      </div>

      <div
        v-if="contextBits.length"
        class="faw-ba-context"
        aria-label="Chat context"
      >
        <template v-for="(bit, i) in contextBits" :key="bit.key">
          <span
            v-if="i > 0"
            class="faw-ba-context__sep"
            aria-hidden="true"
            >·</span
          >
          <span
            class="faw-ba-context__bit"
            :class="{
              'faw-ba-context__bit--accent': bit.tone === 'accent',
              'faw-ba-context__bit--warn': bit.tone === 'warn',
              'faw-ba-context__bit--path': bit.key === 'path',
            }"
            >{{ bit.label }}</span
          >
        </template>
      </div>

      <div
        v-if="!ba.projects.length"
        class="flex-1 flex items-center justify-center px-6"
      >
        <a-empty description="No projects yet — an admin must create and clone one first" />
      </div>

      <template v-else>
        <BaMessageList
          :messages="ba.messages"
          :streaming="ba.streaming"
          :streaming-message-id="ba.streamingMessageId"
          :loading="ba.loading"
          :reset-key="ba.activeThreadId"
          :failed-send="ba.failedPendingSend"
          @use-prompt="onUsePrompt"
          @retry="onRetryFailed"
          @regenerate="onRegenerate"
        />
        <div
          v-if="ba.errorText && !ba.failedPendingSend"
          class="shrink-0 px-3 pb-1"
        >
          <a-alert type="error" show-icon :message="ba.errorText" />
        </div>
        <BaComposer
          ref="composerRef"
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
