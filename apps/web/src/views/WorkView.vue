<script setup lang="ts">
import { reactive, ref, computed } from "vue";
import { Modal } from "ant-design-vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { ArrowLeftOutlined, MoreOutlined } from "@ant-design/icons-vue";
import {
  contextQualityLabel,
  contextQualityColor,
  CONTEXT_QUALITY_STANDARDS,
} from "@/utils/status";
import RelatedTaskPreviewModal from "@/components/RelatedTaskPreviewModal.vue";
import TaskList from "@/components/work/TaskList.vue";
import JobContext from "@/components/work/JobContext.vue";
import AgentConsole from "@/components/work/AgentConsole.vue";
import IssueIidLink from "@/components/IssueIidLink.vue";
import { useWorkbench } from "@/composables/useWorkbench";
import { usePaneLayout } from "@/composables/usePaneLayout";
import { useWorkbenchShortcuts } from "@/composables/useWorkbenchShortcuts";
import { useIsDesktopLg } from "@/composables/useMatchMedia";

/** reactive() unwraps nested refs in template */
const wb = reactive(useWorkbench());
const panes = reactive(usePaneLayout());
/** Mobile must not mount desktop Splitpanes/console — dual tree freezes tab switches. */
const isDesktop = useIsDesktopLg();

const taskListRef = ref<{ focusTaskSearch?: () => void } | null>(null);
const canForceStopRef = computed(() => Boolean(wb.canForceStop));

/** Console tab pulse when agent is active but user is on Issue. */
const consoleTabLive = computed(() => {
  if (wb.mobilePane === "chat") return false;
  if (wb.agentTyping || wb.progressLive || wb.busy || wb.chatLocked) return true;
  const st = wb.currentJob?.status || "";
  return ["running", "queued", "awaiting_clarification"].includes(st);
});

useWorkbenchShortcuts({
  run: () => wb.runCheckedTasks(),
  saveNotes: () => wb.saveNotes({ silent: false }),
  forceStop: () => wb.forceStop(),
  canForceStop: canForceStopRef,
  focusTaskSearch: () => taskListRef.value?.focusTaskSearch?.(),
  closeModal: () => {
    if (wb.handoffOpen) {
      wb.handoffOpen = false;
      return true;
    }
    if (wb.relatedPreviewOpen) {
      wb.relatedPreviewOpen = false;
      return true;
    }
    if (wb.standardsOpen) {
      wb.standardsOpen = false;
      return true;
    }
    if (wb.issueCreateOpen) {
      wb.issueCreateOpen = false;
      return true;
    }
    if (wb.adhocOpen) {
      wb.adhocOpen = false;
      return true;
    }
    if (wb.mobilePane !== "tasks") {
      wb.backToMobileList();
      return true;
    }
    return false;
  },
});

function onPaneResize(event: { panes: Array<{ size: number }> }) {
  panes.onResized(event.panes ?? []);
}

function confirmMergeFromMenu() {
  if (!wb.canQuickMerge || wb.mergeBusy || wb.handoffBusy) return;
  Modal.confirm({
    title: "Merge work → base?",
    content: "If there is a conflict, AI fixes it like Sync base. An open MR is accepted; otherwise local merge + push.",
    okText: "Merge",
    cancelText: "Cancel",
    onOk: () => wb.quickMerge(),
  });
}
</script>

<template>
  <div class="faw-work h-full max-h-full flex flex-col min-h-0 overflow-hidden relative">
    <!-- Desktop: resizable IDE panes — flush like mockup -->
    <div v-if="isDesktop" class="flex flex-1 min-h-0 relative">
      <Splitpanes
        class="work-split faw-split flex-1 min-h-0"
        @resized="onPaneResize"
      >
        <Pane :size="panes.leftSize" :min-size="16" :max-size="40">
          <div class="h-full min-h-0">
            <TaskList
              ref="taskListRef"
              class="w-full h-full"
              :filtered-tasks="wb.filteredTasks"
              :sorted-jobs="wb.sortedJobs"
              :selected-task-iid="wb.selectedTaskIid"
              :selected-job-id="wb.selectedJobId"
              :selected-iids="wb.selectedIids"
              :milestones="wb.milestones"
              :milestone-filter="wb.milestoneFilter"
              :task-labels="wb.taskLabels"
              :label-filter="wb.labelFilter"
              :open-iid-draft="wb.openIidDraft"
              :loading="wb.loading"
              :busy="wb.busy"
              :job-loading="wb.jobLoading"
              :job-status-busy="wb.jobStatusBusy"
              :run-blocked-reason="wb.runBlockedReason"
              :context-is-bad="wb.showBadContextBanner"
              :can-kill-all="wb.canKillAll"
              :kill-all-busy="wb.killAllBusy"
              @update:milestone-filter="wb.setMilestoneFilter($event)"
              @update:label-filter="wb.setLabelFilter($event)"
              @update:open-iid-draft="wb.openIidDraft = $event"
              @refresh="wb.refreshTasks"
              @open-adhoc="wb.openAdhocModal"
              @start-chat="wb.openMobileComposer"
              @run-selected="wb.runCheckedTasks"
              @open-by-iid="wb.openTaskByIid"
              @select-task="wb.onSelectTask"
              @select-job="wb.onSelectJob"
              @toggle-iid="wb.toggleTaskIid"
              @status-change="wb.onJobStatusChange"
              @delete-job="wb.onDeleteJob"
              @kill-all="wb.killAllJobs"
            />
          </div>
        </Pane>

        <Pane :size="panes.midSize" :min-size="28">
          <div class="h-full min-h-0">
            <JobContext
              class="w-full h-full"
              :mid-tab="wb.midTab"
              :job-loading="wb.jobLoading"
              :selected-job-id="wb.selectedJobId"
              :selected-task-iid="wb.selectedTaskIid"
              :current-job="wb.currentJob"
              :task-detail="wb.taskDetail"
              :is-current-adhoc="wb.isCurrentAdhoc"
              :detail-title="wb.detailTitle"
              :detail-meta="wb.detailMeta"
              :context-quality="wb.contextQuality"
              :context-is-bad="wb.showBadContextBanner"
              :run-blocked-reason="wb.runBlockedReason"
              :busy="wb.busy"
              :notes-draft="wb.notesDraft"
              :notes-saving="wb.notesSaving"
              :require-docs-first="wb.requireDocsFirst"
              :plan-first="wb.planFirst"
              :awaiting-docs-approval="wb.awaitingDocsApproval"
              :awaiting-plan-approval="wb.awaitingPlanApproval"
              :approve-docs-busy="wb.approveDocsBusy"
              :approve-plan-busy="wb.approvePlanBusy"
              :related-issues="wb.relatedIssues"
              :human-comments="wb.humanComments"
              :issue-create-busy="wb.issueCreateBusy"
              :job-branch="wb.jobBranch"
              :can-quick-merge="wb.canQuickMerge"
              :can-create-mr="wb.canCreateMr"
              :can-generate-testcases="wb.canGenerateTestcases"
              :can-quick-handoff="wb.canQuickHandoff"
              :can-sync-base="wb.canSyncBase"
              :merge-busy="wb.mergeBusy"
              :create-mr-busy="wb.createMrBusy"
              :testcases-busy="wb.testcasesBusy"
              :handoff-busy="wb.handoffBusy"
              :sync-base-busy="wb.syncBaseBusy"
              :issue-sync-busy="wb.issueSyncBusy"
              @update:mid-tab="wb.midTab = $event"
              @update:notes-draft="wb.notesDraft = $event"
              @update:require-docs-first="wb.requireDocsFirst = $event"
              @open-standards="wb.standardsOpen = true"
              @open-create-issue="wb.openCreateIssueModal"
              @open-related="wb.openRelatedPreview"
              @copy-branch="wb.copyJobBranch"
              @save-notes="() => wb.saveNotes()"
              @notes-input="wb.scheduleNotesAutosave"
              @approve-docs="wb.approveDocs"
              @approve-plan="wb.approvePlan"
              @run-selected="wb.runCurrentJob"
              @quick-merge="wb.quickMerge"
              @create-mr="wb.createMr"
              @generate-testcases="wb.generateTestcases"
              @diff-updated="wb.onDiffUpdated"
              @quick-handoff="wb.openHandoffModal"
              @sync-base="wb.syncBase"
              @refresh-issue="wb.refreshIssueDetail"
            />
          </div>
        </Pane>

        <Pane :size="panes.rightSize" :min-size="22">
          <div class="h-full min-h-0">
            <AgentConsole
              class="w-full h-full"
              :job-loading="wb.jobLoading"
              :current-job="wb.currentJob"
              :chat="wb.chat"
              :agent-typing="wb.agentTyping"
              :progress-lines="wb.progressLines"
              :progress-live="wb.progressLive"
              :chat-input="wb.chatInput"
              :busy="wb.chatLocked"
              :send-busy="wb.sendBusy"
              :stop-busy="wb.stopBusy"
              :can-force-stop="wb.canForceStop"
              :can-reset-window="wb.canResetWindow"
              :agent-window-short="wb.agentWindowShort"
              :context-quality="wb.contextQuality"
              :plan-first="wb.planFirst"
              :failed-send="wb.failedSend"
              @update:chat-input="wb.chatInput = $event"
              @update:plan-first="wb.planFirst = $event"
              @send-chat="wb.sendChat"
              @force-stop="wb.forceStop"
              @reset-window="wb.resetAgentWindow"
              @retry-failed-send="wb.retryFailedSend"
            />
          </div>
        </Pane>
      </Splitpanes>
    </div>

    <!-- Mobile: list ↔ job detail (Issue | Console) -->
    <div v-else class="flex-1 min-h-0 overflow-hidden flex flex-col">
      <TaskList
        ref="taskListRef"
        v-show="wb.mobilePane === 'tasks'"
        class="w-full h-full"
        :filtered-tasks="wb.filteredTasks"
        :sorted-jobs="wb.sortedJobs"
        :selected-task-iid="wb.selectedTaskIid"
        :selected-job-id="wb.selectedJobId"
        :selected-iids="wb.selectedIids"
        :milestones="wb.milestones"
        :milestone-filter="wb.milestoneFilter"
        :task-labels="wb.taskLabels"
        :label-filter="wb.labelFilter"
        :open-iid-draft="wb.openIidDraft"
        :loading="wb.loading"
        :busy="wb.busy"
        :job-loading="wb.jobLoading"
        :job-status-busy="wb.jobStatusBusy"
        :run-blocked-reason="wb.runBlockedReason"
        :context-is-bad="wb.showBadContextBanner"
        :can-kill-all="wb.canKillAll"
        :kill-all-busy="wb.killAllBusy"
        @update:milestone-filter="wb.setMilestoneFilter($event)"
        @update:label-filter="wb.setLabelFilter($event)"
        @update:open-iid-draft="wb.openIidDraft = $event"
        @refresh="wb.refreshTasks"
        @open-adhoc="wb.openAdhocModal"
        @start-chat="wb.openMobileComposer"
        @run-selected="wb.runCheckedTasks"
        @open-by-iid="wb.openTaskByIid"
        @select-task="wb.onSelectTask"
        @select-job="wb.onSelectJob"
        @toggle-iid="wb.toggleTaskIid"
        @status-change="wb.onJobStatusChange"
        @delete-job="wb.onDeleteJob"
        @kill-all="wb.killAllJobs"
      />

      <div
        v-show="wb.mobilePane !== 'tasks'"
        class="flex flex-col w-full flex-1 min-h-0"
        :class="wb.mobilePane !== 'tasks' ? 'faw-m-detail-pad' : ''"
      >
        <!-- Mobile detail chrome: back + title + slim Issue/Console -->
        <div class="faw-m-detail-bar shrink-0">
          <button
            type="button"
            class="faw-m-detail-bar__back touch-manipulation"
            title="Back to tasks"
            aria-label="Back to tasks"
            @click="wb.backToMobileList()"
          >
            <ArrowLeftOutlined />
          </button>
          <div class="faw-m-detail-bar__title min-w-0">
            <div class="faw-m-detail-bar__name truncate">
              <IssueIidLink
                v-if="
                  !wb.isCurrentAdhoc &&
                  (wb.currentJob || wb.selectedTaskIid || wb.taskDetail)
                "
                :iid="
                  wb.taskDetail?.issueIid ||
                  wb.currentJob?.issue?.issueIid ||
                  wb.selectedTaskIid
                "
                link-class="!text-[12px] shrink-0 mr-1"
                :url="wb.taskDetail?.url || wb.currentJob?.issue?.url"
              />
              <span
                v-else
                class="text-status-done font-semibold shrink-0 mr-1"
                >Session</span
              >
              <span>{{ wb.detailTitle || "New session" }}</span>
            </div>
            <div
              v-if="wb.detailMeta"
              class="faw-m-detail-bar__meta truncate"
            >
              {{ wb.detailMeta }}
            </div>
          </div>
          <div class="faw-m-seg" role="tablist" aria-label="Issue or Console">
            <button
              type="button"
              role="tab"
              class="faw-m-seg__btn touch-manipulation"
              :class="{ 'is-active': wb.mobilePane === 'detail' }"
              :aria-selected="wb.mobilePane === 'detail'"
              @click="wb.mobilePane = 'detail'"
            >
              Issue
            </button>
            <button
              type="button"
              role="tab"
              class="faw-m-seg__btn touch-manipulation"
              :class="{
                'is-active': wb.mobilePane === 'chat',
                'is-live': consoleTabLive,
              }"
              :aria-selected="wb.mobilePane === 'chat'"
              @click="wb.mobilePane = 'chat'"
            >
              Console
              <span
                v-if="consoleTabLive"
                class="faw-m-seg__live"
                aria-label="Agent active"
              />
            </button>
          </div>
        </div>

        <JobContext
          v-show="wb.mobilePane === 'detail'"
          class="w-full flex-1 min-h-0"
          hide-sticky-actions
          :mid-tab="wb.midTab"
          :job-loading="wb.jobLoading"
          :selected-job-id="wb.selectedJobId"
          :selected-task-iid="wb.selectedTaskIid"
          :current-job="wb.currentJob"
          :task-detail="wb.taskDetail"
          :is-current-adhoc="wb.isCurrentAdhoc"
          :detail-title="wb.detailTitle"
          :detail-meta="wb.detailMeta"
              :context-quality="wb.contextQuality"
              :context-is-bad="wb.showBadContextBanner"
              :run-blocked-reason="wb.runBlockedReason"
              :busy="wb.busy"
              :notes-draft="wb.notesDraft"
              :notes-saving="wb.notesSaving"
              :require-docs-first="wb.requireDocsFirst"
              :plan-first="wb.planFirst"
              :awaiting-docs-approval="wb.awaitingDocsApproval"
              :awaiting-plan-approval="wb.awaitingPlanApproval"
              :approve-docs-busy="wb.approveDocsBusy"
              :approve-plan-busy="wb.approvePlanBusy"
              :related-issues="wb.relatedIssues"
              :human-comments="wb.humanComments"
              :issue-create-busy="wb.issueCreateBusy"
              :job-branch="wb.jobBranch"
              :can-quick-merge="wb.canQuickMerge"
          :can-create-mr="wb.canCreateMr"
          :can-generate-testcases="wb.canGenerateTestcases"
          :can-quick-handoff="wb.canQuickHandoff"
          :can-sync-base="wb.canSyncBase"
          :merge-busy="wb.mergeBusy"
          :create-mr-busy="wb.createMrBusy"
          :testcases-busy="wb.testcasesBusy"
          :handoff-busy="wb.handoffBusy"
          :sync-base-busy="wb.syncBaseBusy"
          :issue-sync-busy="wb.issueSyncBusy"
          @update:mid-tab="wb.midTab = $event"
          @update:notes-draft="wb.notesDraft = $event"
          @update:require-docs-first="wb.requireDocsFirst = $event"
          @open-standards="wb.standardsOpen = true"
          @open-create-issue="wb.openCreateIssueModal"
          @open-related="wb.openRelatedPreview"
          @copy-branch="wb.copyJobBranch"
          @save-notes="() => wb.saveNotes()"
          @notes-input="wb.scheduleNotesAutosave"
          @approve-docs="wb.approveDocs"
          @approve-plan="wb.approvePlan"
          @run-selected="wb.runCurrentJob"
          @quick-merge="wb.quickMerge"
          @create-mr="wb.createMr"
          @generate-testcases="wb.generateTestcases"
          @diff-updated="wb.onDiffUpdated"
          @quick-handoff="wb.openHandoffModal"
          @sync-base="wb.syncBase"
          @refresh-issue="wb.refreshIssueDetail"
        />
        <AgentConsole
          v-show="wb.mobilePane === 'chat'"
          class="w-full flex-1 min-h-0"
          mobile-tabs
          :job-loading="wb.jobLoading"
          :current-job="wb.currentJob"
          :chat="wb.chat"
          :agent-typing="wb.agentTyping"
          :progress-lines="wb.progressLines"
          :progress-live="wb.progressLive"
          :chat-input="wb.chatInput"
          :busy="wb.chatLocked"
          :send-busy="wb.sendBusy"
          :stop-busy="wb.stopBusy"
          :can-force-stop="wb.canForceStop"
          :can-reset-window="wb.canResetWindow"
          :agent-window-short="wb.agentWindowShort"
          :context-quality="wb.contextQuality"
          :plan-first="wb.planFirst"
          :failed-send="wb.failedSend"
          @update:chat-input="wb.chatInput = $event"
          @update:plan-first="wb.planFirst = $event"
          @send-chat="wb.sendChat"
          @force-stop="wb.forceStop"
          @reset-window="wb.resetAgentWindow"
          @retry-failed-send="wb.retryFailedSend"
        />
      </div>
    </div>

    <!-- Mobile action dock: Run | Handoff equal pair + overflow (Issue + Console) -->
    <div
      v-if="!isDesktop && wb.mobilePane !== 'tasks'"
      class="faw-m-dock"
      role="toolbar"
      aria-label="Job actions"
    >
      <div class="faw-m-dock__pair">
        <a-tooltip title="Run agent">
          <button
            type="button"
            class="faw-m-btn faw-m-btn--primary touch-manipulation"
            :disabled="wb.busy"
            aria-label="Run agent"
            @click="wb.runCurrentJob()"
          >
            {{ wb.busy ? "Running…" : "Run" }}
          </button>
        </a-tooltip>
        <a-tooltip
          :title="
            wb.canQuickHandoff
              ? 'Handoff — pick assignee'
              : 'Only when job is Awaiting handoff / Done'
          "
        >
          <button
            type="button"
            class="faw-m-btn faw-m-btn--handoff touch-manipulation"
            :disabled="!wb.canQuickHandoff || wb.handoffBusy || wb.mergeBusy"
            aria-label="Handoff"
            @click="wb.openHandoffModal()"
          >
            {{ wb.handoffBusy ? "…" : "Handoff" }}
          </button>
        </a-tooltip>
      </div>
      <button
        v-if="wb.awaitingPlanApproval"
        type="button"
        class="faw-m-btn faw-m-btn--plan touch-manipulation"
        :disabled="wb.approvePlanBusy"
        aria-label="Approve plan"
        @click="wb.approvePlan()"
      >
        {{ wb.approvePlanBusy ? "…" : "Plan" }}
      </button>
      <a-dropdown placement="topRight" :trigger="['click']">
        <button
          type="button"
          class="faw-m-btn faw-m-btn--more touch-manipulation"
          title="More actions"
          aria-label="More actions"
        >
          <MoreOutlined />
        </button>
        <template #overlay>
          <a-menu>
            <a-menu-item
              key="sync"
              :disabled="!wb.canSyncBase || wb.syncBaseBusy"
              @click="wb.syncBase()"
            >
              {{ wb.syncBaseBusy ? "Syncing…" : "⇣ Sync base" }}
            </a-menu-item>
            <a-menu-item
              key="mr"
              :disabled="!wb.canCreateMr || wb.createMrBusy || wb.mergeBusy"
              @click="wb.createMr()"
            >
              {{ wb.createMrBusy ? "Creating…" : "Create MR" }}
            </a-menu-item>
            <a-menu-item
              key="merge"
              :disabled="!wb.canQuickMerge || wb.mergeBusy || wb.handoffBusy"
              @click="confirmMergeFromMenu"
            >
              {{ wb.mergeBusy ? "Merging…" : "Merge → base" }}
            </a-menu-item>
            <a-menu-item
              key="testcases"
              :disabled="!wb.canGenerateTestcases || wb.testcasesBusy"
              @click="wb.generateTestcases()"
            >
              {{ wb.testcasesBusy ? "TC…" : "Generate Testcase" }}
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
    </div>

    <a-modal
      v-model:open="wb.adhocOpen"
      title="New session"
      ok-text="Start"
      cancel-text="Cancel"
      :confirm-loading="wb.adhocBusy"
      class="shadow-xl"
      wrap-class-name="work-modal-sheet"
      :centered="false"
      @ok="wb.startAdhoc"
    >
      <a-form layout="vertical" class="mt-2">
        <a-form-item label="Title (optional if you describe the request)">
          <a-input
            v-model:value="wb.adhocTitle"
            placeholder="e.g. Fix login timeout on mobile"
            @pressEnter="wb.startAdhoc"
          />
        </a-form-item>
        <a-form-item label="Request">
          <a-textarea
            v-model:value="wb.adhocMessage"
            :rows="4"
            placeholder="Describe what the agent should do — Send in Console also starts a session"
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="wb.issueCreateOpen"
      title="Create GitLab issue"
      ok-text="Create issue"
      cancel-text="Cancel"
      :confirm-loading="wb.issueCreateBusy"
      :width="640"
      wrap-class-name="work-modal-sheet"
      :centered="false"
      @ok="wb.submitCreateIssue"
    >
      <a-spin :spinning="wb.issueCreateBusy && !wb.issueTitle">
        <a-form layout="vertical" class="mt-2">
          <a-form-item label="Title" required>
            <a-input v-model:value="wb.issueTitle" />
          </a-form-item>
          <a-form-item label="Description">
            <a-textarea v-model:value="wb.issueDescription" :rows="10" />
          </a-form-item>
          <a-form-item label="Labels">
            <a-select
              v-model:value="wb.issueLabels"
              mode="multiple"
              class="w-full"
              :options="wb.labels.map((l) => ({ value: l, label: l }))"
              placeholder="Optional"
            />
          </a-form-item>
        </a-form>
      </a-spin>
    </a-modal>

    <a-modal
      v-model:open="wb.syncBaseOpen"
      title="Sync base into job branch"
      ok-text="Pull base"
      cancel-text="Cancel"
      :ok-button-props="{ disabled: !wb.syncBaseChoice || wb.syncBaseBranchesLoading }"
      :confirm-loading="wb.syncBaseBusy"
      wrap-class-name="work-modal-sheet"
      :centered="false"
      @ok="wb.confirmSyncBase"
    >
      <div class="faw-sync-base-modal">
        <p class="faw-sync-base-modal__lead">
          This project has no Main branch in Settings — pick the branch to pull
          into the job branch. We will not guess a default.
        </p>
        <label class="faw-sync-base-modal__label" for="sync-base-branch">
          Base branch
        </label>
        <a-select
          id="sync-base-branch"
          v-model:value="wb.syncBaseChoice"
          class="w-full"
          show-search
          :loading="wb.syncBaseBranchesLoading"
          placeholder="Choose a branch…"
          :options="
            wb.syncBaseBranches.map((b: string) => ({ value: b, label: b }))
          "
        />
        <p class="faw-sync-base-modal__hint">
          On conflict, AI tries to resolve; if it fails, use Chat Send or retry
          Sync base. Progress appears under Sync base / Merge history.
        </p>
      </div>
    </a-modal>

    <a-modal
      v-model:open="wb.standardsOpen"
      title="Context Quality Standards"
      :footer="null"
      :width="520"
      destroy-on-close
      wrap-class-name="work-modal-sheet"
      :centered="false"
    >
      <p class="text-xs text-ink-muted m-0 mb-3 leading-relaxed">
        Gate on Run / chat follow-up. Clear Dev Notes (long enough + technical
        signals) count as <strong>Good</strong>.
      </p>
      <div
        v-for="(std, key) in CONTEXT_QUALITY_STANDARDS"
        :key="key"
        class="mb-3 last:mb-0 rounded-xl border border-line px-3 py-2.5 shadow-sm"
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

    <a-modal
      v-model:open="wb.handoffOpen"
      ok-text="Handoff"
      cancel-text="Cancel"
      :confirm-loading="wb.handoffBusy"
      :width="420"
      wrap-class-name="work-modal-sheet"
      :centered="false"
      @ok="wb.quickHandoff"
    >
      <template #title>
        <div class="faw-handoff-modal__title">
          <span class="faw-handoff-modal__title-dot" aria-hidden="true" />
          <span>Handoff</span>
        </div>
      </template>
      <div class="faw-handoff-modal">
        <div class="faw-handoff-modal__field">
          <div class="faw-handoff-modal__label-row">
            <label class="faw-handoff-modal__label" for="handoff-assignee">
              Assign to
            </label>
            <span class="faw-handoff-modal__chip">This time only</span>
          </div>
          <a-select
            id="handoff-assignee"
            v-model:value="wb.handoffAssignee"
            allow-clear
            show-search
            size="large"
            class="w-full faw-handoff-modal__select"
            placeholder="Search member…"
            :options="
              (wb.members || []).map((m) => ({
                value: m.username,
                label: m.name ? `${m.name} (@${m.username})` : `@${m.username}`,
              }))
            "
            :filter-option="
              (input, option) =>
                String(option?.label || '')
                  .toLowerCase()
                  .includes(String(input || '').toLowerCase())
            "
          />
        </div>
      </div>
    </a-modal>

    <RelatedTaskPreviewModal
      v-model:open="wb.relatedPreviewOpen"
      :loading="wb.relatedPreviewLoading"
      :detail="wb.relatedPreview"
      :error="wb.relatedPreviewError"
      :fallback="wb.relatedPreviewFallback"
    />
  </div>
</template>
