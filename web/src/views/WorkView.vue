<script setup lang="ts">
import { reactive } from "vue";
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

/** reactive() unwraps nested refs in template */
const wb = reactive(useWorkbench());
const panes = reactive(usePaneLayout());

useWorkbenchShortcuts({
  run: () => wb.runCheckedTasks(),
  saveNotes: () => wb.saveNotes({ silent: false }),
  closeModal: () => {
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
    okText: "Merge",
    cancelText: "Cancel",
    onOk: () => wb.quickMerge(),
  });
}
</script>

<template>
  <div class="faw-work h-full max-h-full flex flex-col min-h-0 overflow-hidden relative">
    <!-- Desktop: resizable IDE panes — flush like mockup -->
    <div class="hidden lg:flex flex-1 min-h-0 relative">
      <Splitpanes
        class="work-split faw-split default-theme flex-1 min-h-0"
        @resized="onPaneResize"
      >
        <Pane :size="panes.leftSize" :min-size="16" :max-size="40">
          <div class="h-full min-h-0">
            <TaskList
              class="w-full h-full"
              :filtered-tasks="wb.filteredTasks"
              :sorted-jobs="wb.sortedJobs"
              :selected-task-iid="wb.selectedTaskIid"
              :selected-job-id="wb.selectedJobId"
              :selected-iids="wb.selectedIids"
              :milestones="wb.milestones"
              :milestone-filter="wb.milestoneFilter"
              :open-iid-draft="wb.openIidDraft"
              :loading="wb.loading"
              :busy="wb.busy"
              :job-loading="wb.jobLoading"
              :job-status-busy="wb.jobStatusBusy"
              :run-blocked-reason="wb.runBlockedReason"
              :context-is-bad="wb.contextIsBad"
              :can-kill-all="wb.canKillAll"
              :kill-all-busy="wb.killAllBusy"
              @update:milestone-filter="wb.setMilestoneFilter($event)"
              @update:open-iid-draft="wb.openIidDraft = $event"
              @refresh="wb.refreshTasks"
              @open-adhoc="wb.openAdhocModal"
              @run-selected="wb.runCheckedTasks"
              @run-all="wb.runAll"
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
              :context-is-bad="wb.contextIsBad"
              :run-blocked-reason="wb.runBlockedReason"
              :busy="wb.busy"
              :notes-draft="wb.notesDraft"
              :notes-saving="wb.notesSaving"
              :require-docs-first="wb.requireDocsFirst"
              :awaiting-docs-approval="wb.awaitingDocsApproval"
              :approve-docs-busy="wb.approveDocsBusy"
              :related-issues="wb.relatedIssues"
              :human-comments="wb.humanComments"
              :issue-create-busy="wb.issueCreateBusy"
              :job-branch="wb.jobBranch"
              :can-quick-merge="wb.canQuickMerge"
              :can-create-mr="wb.canCreateMr"
              :can-quick-handoff="wb.canQuickHandoff"
              :can-sync-base="wb.canSyncBase"
              :merge-busy="wb.mergeBusy"
              :create-mr-busy="wb.createMrBusy"
              :handoff-busy="wb.handoffBusy"
              :sync-base-busy="wb.syncBaseBusy"
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
              @run-selected="wb.runCurrentJob"
              @quick-merge="wb.quickMerge"
              @create-mr="wb.createMr"
              @diff-updated="wb.onDiffUpdated"
              @quick-handoff="wb.quickHandoff"
              @sync-base="wb.syncBase"
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
              :stop-busy="wb.stopBusy"
              :can-force-stop="wb.canForceStop"
              :can-reset-window="wb.canResetWindow"
              :agent-window-short="wb.agentWindowShort"
              :context-quality="wb.contextQuality"
              @update:chat-input="wb.chatInput = $event"
              @send-chat="wb.sendChat"
              @force-stop="wb.forceStop"
              @reset-window="wb.resetAgentWindow"
            />
          </div>
        </Pane>
      </Splitpanes>
    </div>

    <!-- Mobile: list ↔ job detail (Issue | Console) -->
    <div class="lg:hidden flex-1 min-h-0 overflow-hidden flex flex-col">
      <TaskList
        v-show="wb.mobilePane === 'tasks'"
        class="w-full h-full"
        :filtered-tasks="wb.filteredTasks"
        :sorted-jobs="wb.sortedJobs"
        :selected-task-iid="wb.selectedTaskIid"
        :selected-job-id="wb.selectedJobId"
        :selected-iids="wb.selectedIids"
        :milestones="wb.milestones"
        :milestone-filter="wb.milestoneFilter"
        :open-iid-draft="wb.openIidDraft"
        :loading="wb.loading"
        :busy="wb.busy"
        :job-loading="wb.jobLoading"
        :job-status-busy="wb.jobStatusBusy"
        :run-blocked-reason="wb.runBlockedReason"
        :context-is-bad="wb.contextIsBad"
        :can-kill-all="wb.canKillAll"
        :kill-all-busy="wb.killAllBusy"
        @update:milestone-filter="wb.setMilestoneFilter($event)"
        @update:open-iid-draft="wb.openIidDraft = $event"
        @refresh="wb.refreshTasks"
        @open-adhoc="wb.openAdhocModal"
        @run-selected="wb.runCheckedTasks"
        @run-all="wb.runAll"
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
        :class="wb.mobilePane === 'detail' ? 'pb-10' : ''"
      >
        <!-- Mobile detail chrome: back + title + slim Issue/Console -->
        <div class="faw-m-detail-bar shrink-0">
          <button
            type="button"
            class="faw-m-detail-bar__back touch-manipulation"
            title="Back to tasks"
            @click="wb.backToMobileList()"
          >
            <ArrowLeftOutlined />
          </button>
          <div class="faw-m-detail-bar__title min-w-0">
            <div class="faw-m-detail-bar__name truncate">
              <IssueIidLink
                v-if="!wb.isCurrentAdhoc"
                :iid="
                  wb.taskDetail?.issueIid ||
                  wb.currentJob?.issue?.issueIid ||
                  wb.selectedTaskIid
                "
                :url="wb.taskDetail?.url || wb.currentJob?.issue?.url"
                link-class="!text-[12px] shrink-0 mr-1"
              />
              <span
                v-else
                class="text-status-done font-semibold shrink-0 mr-1"
                >Hotfix</span
              >
              <span>{{ wb.detailTitle || "—" }}</span>
            </div>
            <div
              v-if="wb.detailMeta"
              class="faw-m-detail-bar__meta truncate"
            >
              {{ wb.detailMeta }}
            </div>
          </div>
          <div class="faw-m-seg" role="tablist">
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
              :class="{ 'is-active': wb.mobilePane === 'chat' }"
              :aria-selected="wb.mobilePane === 'chat'"
              @click="wb.mobilePane = 'chat'"
            >
              Console
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
          :context-is-bad="wb.contextIsBad"
          :run-blocked-reason="wb.runBlockedReason"
          :busy="wb.busy"
          :notes-draft="wb.notesDraft"
          :notes-saving="wb.notesSaving"
          :require-docs-first="wb.requireDocsFirst"
          :awaiting-docs-approval="wb.awaitingDocsApproval"
          :approve-docs-busy="wb.approveDocsBusy"
          :related-issues="wb.relatedIssues"
          :human-comments="wb.humanComments"
          :issue-create-busy="wb.issueCreateBusy"
          :job-branch="wb.jobBranch"
          :can-quick-merge="wb.canQuickMerge"
          :can-create-mr="wb.canCreateMr"
          :can-quick-handoff="wb.canQuickHandoff"
          :can-sync-base="wb.canSyncBase"
          :merge-busy="wb.mergeBusy"
          :create-mr-busy="wb.createMrBusy"
          :handoff-busy="wb.handoffBusy"
          :sync-base-busy="wb.syncBaseBusy"
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
          @run-selected="wb.runCurrentJob"
          @quick-merge="wb.quickMerge"
          @create-mr="wb.createMr"
          @diff-updated="wb.onDiffUpdated"
          @quick-handoff="wb.quickHandoff"
          @sync-base="wb.syncBase"
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
          :stop-busy="wb.stopBusy"
          :can-force-stop="wb.canForceStop"
          :can-reset-window="wb.canResetWindow"
          :agent-window-short="wb.agentWindowShort"
          :context-quality="wb.contextQuality"
          @update:chat-input="wb.chatInput = $event"
          @send-chat="wb.sendChat"
          @force-stop="wb.forceStop"
          @reset-window="wb.resetAgentWindow"
        />
      </div>
    </div>

    <!-- Mobile action dock: Run | Handoff equal pair + overflow -->
    <div
      v-if="wb.mobilePane === 'detail'"
      class="faw-m-dock lg:hidden"
    >
      <div class="faw-m-dock__pair">
        <a-tooltip :title="wb.runBlockedReason || 'Run agent'">
          <button
            type="button"
            class="faw-m-btn faw-m-btn--primary touch-manipulation"
            :disabled="wb.busy || Boolean(wb.runBlockedReason)"
            @click="wb.runCurrentJob()"
          >
            {{ wb.busy ? "Running…" : "Run" }}
          </button>
        </a-tooltip>
        <a-popconfirm
          title="Handoff with Settings prefs?"
          ok-text="Handoff"
          cancel-text="Cancel"
          :disabled="!wb.canQuickHandoff || wb.handoffBusy"
          @confirm="wb.quickHandoff()"
        >
          <button
            type="button"
            class="faw-m-btn faw-m-btn--handoff touch-manipulation"
            :disabled="!wb.canQuickHandoff || wb.handoffBusy || wb.mergeBusy"
          >
            {{ wb.handoffBusy ? "…" : "Handoff" }}
          </button>
        </a-popconfirm>
      </div>
      <button
        v-if="wb.awaitingDocsApproval"
        type="button"
        class="faw-m-btn faw-m-btn--docs touch-manipulation"
        :disabled="wb.approveDocsBusy"
        @click="wb.approveDocs()"
      >
        {{ wb.approveDocsBusy ? "…" : "Docs" }}
      </button>
      <a-dropdown placement="topRight" :trigger="['click']">
        <button
          type="button"
          class="faw-m-btn faw-m-btn--more touch-manipulation"
          title="More actions"
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
          </a-menu>
        </template>
      </a-dropdown>
    </div>

    <a-modal
      v-model:open="wb.adhocOpen"
      title="New session / Hotfix"
      ok-text="Start"
      cancel-text="Cancel"
      :confirm-loading="wb.adhocBusy"
      class="shadow-xl"
      wrap-class-name="work-modal-sheet"
      :centered="false"
      @ok="wb.startAdhoc"
    >
      <a-form layout="vertical" class="mt-2">
        <a-form-item label="Title" required>
          <a-input
            v-model:value="wb.adhocTitle"
            placeholder="e.g. Hotfix crash login mobile"
            @pressEnter="wb.startAdhoc"
          />
        </a-form-item>
        <a-form-item label="Initial request (optional)">
          <a-textarea
            v-model:value="wb.adhocMessage"
            :rows="4"
            placeholder="Describe what the agent should do…"
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
      title="Chọn nhánh nguồn để pull"
      ok-text="Pull"
      cancel-text="Cancel"
      :ok-button-props="{ disabled: !wb.syncBaseChoice }"
      wrap-class-name="work-modal-sheet"
      :centered="false"
      @ok="wb.confirmSyncBase"
    >
      <p class="text-xs text-ink-muted mt-0 mb-2 leading-relaxed">
        Project chưa cấu hình Main branch trong Settings — chọn nhánh muốn pull
        vào nhánh job (không tự đoán default).
      </p>
      <a-select
        v-model:value="wb.syncBaseChoice"
        class="w-full"
        show-search
        :loading="wb.syncBaseBranchesLoading"
        placeholder="Chọn nhánh…"
        :options="wb.syncBaseBranches.map((b: string) => ({ value: b, label: b }))"
      />
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

    <RelatedTaskPreviewModal
      v-model:open="wb.relatedPreviewOpen"
      :loading="wb.relatedPreviewLoading"
      :detail="wb.relatedPreview"
      :error="wb.relatedPreviewError"
      :fallback="wb.relatedPreviewFallback"
    />

    <!-- <p
      class="hidden lg:block pointer-events-none absolute bottom-1 right-3 text-[10px] text-ink-faint/70 font-mono m-0"
    >
      ⌘/Ctrl+Enter Run · ⌘/Ctrl+S Notes · Esc Modal
    </p> -->
  </div>
</template>
