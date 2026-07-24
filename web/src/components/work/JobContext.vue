<script setup lang="ts">
import { CopyOutlined } from "@ant-design/icons-vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import JobDiffPanel from "@/components/JobDiffPanel.vue";
import {
  contextQualityLabel,
  contextQualityColor,
} from "@/utils/status";
import type { Job, TaskDetail } from "@/stores/work";
import type { MidTab } from "@/composables/useWorkbench";

defineProps<{
  midTab: MidTab;
  jobLoading: boolean;
  selectedJobId: string | null;
  selectedTaskIid: number | null;
  currentJob: Job | null;
  taskDetail: TaskDetail | null;
  isCurrentAdhoc: boolean;
  detailTitle: string;
  detailMeta: string;
  contextQuality: Job["contextQuality"] | null;
  contextIsBad: boolean;
  runBlockedReason: string | null;
  busy: boolean;
  notesDraft: string;
  notesSaving: boolean;
  requireDocsFirst: boolean;
  awaitingDocsApproval: boolean;
  approveDocsBusy: boolean;
  relatedIssues: NonNullable<TaskDetail["related"]>;
  humanComments: NonNullable<TaskDetail["notes"]>;
  issueCreateBusy: boolean;
  jobBranch: (j: { branch?: string; workBranch?: string }) => string;
  canQuickMerge: boolean;
  canQuickHandoff: boolean;
  mergeBusy: boolean;
  handoffBusy: boolean;
  /** Larger touch targets + gap for mobile sticky bar */
  mobileTouch?: boolean;
  /** Hide internal sticky (WorkView owns mobile action dock) */
  hideStickyActions?: boolean;
}>();

const emit = defineEmits<{
  "update:midTab": [MidTab];
  "update:notesDraft": [string];
  "update:requireDocsFirst": [boolean];
  openStandards: [];
  openCreateIssue: [];
  openRelated: [opts: { iid: number; title?: string; url?: string }];
  copyBranch: [string];
  saveNotes: [];
  notesInput: [];
  approveDocs: [];
  runSelected: [];
  quickMerge: [];
  quickHandoff: [];
}>();
</script>

<template>
  <section
    class="flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel relative h-full"
  >
    <div
      v-if="jobLoading"
      class="absolute inset-0 z-20 rounded-2xl bg-surface-raised p-4 space-y-3 border border-line"
      aria-busy="true"
    >
      <div class="skel h-5 w-40" />
      <div class="skel h-3 w-full" />
      <div class="skel h-3 w-[92%]" />
      <div class="skel h-28 w-full mt-4" />
      <div class="skel h-3 w-3/4" />
      <div class="skel h-3 w-2/3" />
      <div class="skel h-20 w-full mt-2" />
    </div>

    <a-tabs
      v-show="!jobLoading"
      :activeKey="midTab"
      class="work-tabs flex-1 min-h-0 px-3 pt-1"
      @update:activeKey="(k: string) => emit('update:midTab', k as MidTab)"
    >
      <a-tab-pane key="detail" tab="Issue">
        <div class="h-full min-h-0 overflow-y-auto pr-2 space-y-4" :class="hideStickyActions ? 'pb-3' : 'pb-24'">
          <template v-if="taskDetail || currentJob">
            <a-alert
              v-if="isCurrentAdhoc"
              type="info"
              show-icon
              class="mt-2"
              message="Session Hotfix — chưa có GitLab issue"
            >
              <template #action>
                <a-button
                  size="small"
                  type="primary"
                  :loading="issueCreateBusy"
                  @click="emit('openCreateIssue')"
                  >Tạo issue GitLab</a-button
                >
              </template>
            </a-alert>

            <a-alert
              v-if="awaitingDocsApproval"
              type="success"
              show-icon
              class="mt-2"
              message="Docs phase xong — duyệt để chạy code"
            >
              <template #action>
                <a-button
                  size="small"
                  type="primary"
                  class="!bg-violet-600 hover:!bg-violet-500"
                  :loading="approveDocsBusy"
                  @click="emit('approveDocs')"
                  >Approve Docs</a-button
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
                v-if="currentJob && jobBranch(currentJob)"
                class="text-xs text-ink-faint m-0 mb-1 font-mono flex items-center gap-1.5 flex-wrap"
              >
                <span class="truncate">{{ jobBranch(currentJob) }}</span>
                <button
                  type="button"
                  class="text-ink-faint hover:text-accent"
                  title="Copy branch"
                  @click="emit('copyBranch', jobBranch(currentJob))"
                >
                  <CopyOutlined class="text-[11px]" />
                </button>
                <span v-if="currentJob.commitSha" class="text-ink-faint">
                  · {{ currentJob.commitSha.slice(0, 8) }}</span
                >
              </p>
              <p v-if="detailMeta" class="text-xs text-ink-faint m-0 mb-2">
                {{ detailMeta }}
              </p>

              <div class="mb-3 flex items-center gap-2 flex-wrap text-xs">
                <template v-if="contextQuality?.level">
                  <span
                    class="text-[11px] uppercase tracking-wide text-ink-faint"
                    >Context</span
                  >
                  <a-tag
                    :color="contextQualityColor(contextQuality.level)"
                    class="m-0"
                    :title="contextQuality.reason || ''"
                    >{{ contextQualityLabel(contextQuality.level) }}</a-tag
                  >
                </template>
                <a-button
                  size="small"
                  type="link"
                  class="!px-0 !h-auto"
                  @click="emit('openStandards')"
                  >Xem tiêu chuẩn</a-button
                >
              </div>

              <a-alert
                v-if="contextIsBad"
                type="error"
                show-icon
                class="mb-3"
                message="Bad Context — Run bị chặn"
                :description="
                  currentJob?.lastQuestion ||
                  'Bổ sung Dev Notes hoặc mô tả kỹ thuật rồi Run lại.'
                "
              />

              <div
                v-if="!isCurrentAdhoc && taskDetail?.labels?.length"
                class="flex flex-wrap gap-1 mb-3"
              >
                <a-tag v-for="l in taskDetail.labels" :key="l" class="m-0">{{
                  l
                }}</a-tag>
              </div>
              <div
                class="text-sm text-ink-soft rounded-xl bg-surface-soft border border-line p-3"
              >
                <ChatMessageBody
                  v-if="isCurrentAdhoc"
                  role="agent"
                  :markdown="true"
                  :body="
                    currentJob?.summary?.trim() ||
                    'Chưa có summary — chat với agent hoặc mô tả việc cần làm.'
                  "
                />
                <ChatMessageBody
                  v-else
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
                      emit('openRelated', {
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
                    @click="emit('openStandards')"
                    >tiêu chuẩn</a-button
                  >
                  <span
                    v-if="notesSaving"
                    class="text-[10px] text-ink-faint"
                    >đang lưu…</span
                  >
                </div>
                <a-button
                  size="small"
                  type="primary"
                  :loading="notesSaving"
                  title="⌘/Ctrl+S"
                  @click="emit('saveNotes')"
                  >Lưu</a-button
                >
              </div>
              <a-textarea
                :value="notesDraft"
                :rows="4"
                placeholder="Chỉ dẫn kỹ thuật rõ ràng (≥ ~25 từ + file/route/field…) → Good Context"
                @update:value="
                  (v: string) => {
                    emit('update:notesDraft', v);
                    emit('notesInput');
                  }
                "
              />
              <div class="mt-2 flex items-center gap-2">
                <a-switch
                  :checked="requireDocsFirst"
                  size="small"
                  @update:checked="
                    (v: boolean) => emit('update:requireDocsFirst', v)
                  "
                />
                <span class="text-xs text-ink-muted"
                  >Docs-first (đọc docs trước khi code)</span
                >
              </div>
            </div>
          </template>
          <a-empty v-else description="Chọn task hoặc job">
            <span class="text-xs text-ink-faint"
              >Chọn ở cột trái để xem context và Run</span
            >
          </a-empty>
        </div>
      </a-tab-pane>

      <a-tab-pane key="diff" tab="Diff" :disabled="!selectedJobId">
        <div class="h-full min-h-0 flex flex-col overflow-hidden" :class="hideStickyActions ? 'pb-1' : 'pb-16'">
          <JobDiffPanel
            class="flex-1 min-h-0"
            :job-id="selectedJobId"
            :branch="currentJob ? jobBranch(currentJob) : null"
          />
        </div>
      </a-tab-pane>
    </a-tabs>

    <!-- Sticky action bar (Issue) — desktop / non-dock mobile -->
    <div
      v-show="!jobLoading && !hideStickyActions"
      class="absolute bottom-0 inset-x-0 z-[5] border-t border-line bg-surface-raised/95 backdrop-blur-sm px-3 py-2.5 flex items-center flex-wrap shadow-sm"
      :class="mobileTouch ? 'gap-4' : 'gap-2'"
    >
      <a-tooltip :title="runBlockedReason || 'Chạy agent trên task đã chọn'">
        <a-button
          type="primary"
          :class="mobileTouch ? 'min-w-[6.5rem] !min-h-[44px]' : 'min-w-[6.5rem]'"
          :loading="busy"
          :disabled="Boolean(runBlockedReason)"
          @click="emit('runSelected')"
          >Run</a-button
        >
      </a-tooltip>
      <a-button
        v-if="awaitingDocsApproval"
        type="primary"
        class="!bg-violet-600"
        :class="mobileTouch ? '!min-h-[44px]' : ''"
        :loading="approveDocsBusy"
        @click="emit('approveDocs')"
        >Approve Docs</a-button
      >
      <a-popconfirm
        title="Merge work branch → base?"
        ok-text="Merge"
        cancel-text="Huỷ"
        :disabled="!canQuickMerge || mergeBusy"
        @confirm="emit('quickMerge')"
      >
        <a-tooltip
          :title="
            canQuickMerge
              ? 'Merge nhanh (work → base)'
              : 'Chỉ khi job ở Awaiting handoff'
          "
        >
          <a-button
            :class="mobileTouch ? '!min-h-[44px]' : ''"
            :loading="mergeBusy"
            :disabled="!canQuickMerge || mergeBusy || handoffBusy"
            >Merge</a-button
          >
        </a-tooltip>
      </a-popconfirm>
      <a-popconfirm
        title="Handoff với prefs Settings (assignee / labels)?"
        ok-text="Handoff"
        cancel-text="Huỷ"
        :disabled="!canQuickHandoff || handoffBusy"
        @confirm="emit('quickHandoff')"
      >
        <a-tooltip
          :title="
            canQuickHandoff
              ? 'Handoff nhanh (Settings → Labels)'
              : 'Chỉ khi job ở Awaiting handoff'
          "
        >
          <a-button
            type="primary"
            ghost
            class="!border-cyan-600 !text-cyan-700"
            :class="mobileTouch ? '!min-h-[44px]' : ''"
            :loading="handoffBusy"
            :disabled="!canQuickHandoff || handoffBusy || mergeBusy"
            >Handoff</a-button
          >
        </a-tooltip>
      </a-popconfirm>
      <span v-if="contextIsBad" class="text-xs text-red-600 truncate">{{
        runBlockedReason
      }}</span>
    </div>
  </section>
</template>
