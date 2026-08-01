<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { CopyOutlined } from "@ant-design/icons-vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import IssueIidLink from "@/components/IssueIidLink.vue";
import JobDiffPanel from "@/components/JobDiffPanel.vue";
import { jobApi } from "@/api/jobApi";
import { useWorkStore } from "@/stores/work";
import {
  contextQualityLabel,
  contextQualityColor,
} from "@/utils/status";
import type { Job, TaskDetail } from "@/stores/work";
import type { MidTab } from "@/composables/useWorkbench";

const props = defineProps<{
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
  canCreateMr: boolean;
  canQuickHandoff: boolean;
  canSyncBase: boolean;
  mergeBusy: boolean;
  createMrBusy: boolean;
  handoffBusy: boolean;
  syncBaseBusy: boolean;
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
  createMr: [];
  quickHandoff: [];
  syncBase: [];
  diffUpdated: [];
}>();

const work = useWorkStore();
const googleBusy = ref(false);
const autoContinueAfterAuth = ref(false);
const googleStatus = ref<{
  configured: boolean;
  authorized: boolean;
  email?: string;
  sheetIds: string[];
  pendingSheetUrls: string[];
} | null>(null);
const detectedSheets = ref<
  { spreadsheetId: string; url: string; gid?: string }[]
>([]);
const includeSheetIds = ref<string[]>([]);
const includeSaving = ref(false);

const awaitingGoogleAuth = computed(
  () => props.currentJob?.status === "awaiting_google_auth",
);

const showGoogleCard = computed(
  () =>
    awaitingGoogleAuth.value ||
    Boolean(googleStatus.value?.authorized || googleStatus.value?.email) ||
    Boolean(props.currentJob?.googleAuth?.email) ||
    Boolean(props.currentJob?.pendingGoogleSheetUrls?.length) ||
    detectedSheets.value.length > 0,
);

function sheetLabel(s: { spreadsheetId: string; url: string }): string {
  try {
    const u = new URL(s.url);
    if (u.hostname.includes("docs.google.com")) {
      return `Sheets …${s.spreadsheetId.slice(-8)}`;
    }
    if (u.hostname.includes("drive.google.com")) {
      return `Drive …${s.spreadsheetId.slice(-8)}`;
    }
  } catch {
    /* ignore */
  }
  return `…${s.spreadsheetId.slice(-10)}`;
}

async function refreshGoogleStatus() {
  const id = props.selectedJobId;
  if (!id) {
    googleStatus.value = null;
    detectedSheets.value = [];
    includeSheetIds.value = [];
    return;
  }
  try {
    const [status, detected] = await Promise.all([
      jobApi.googleStatus(id),
      jobApi.googleDetect(id),
    ]);
    googleStatus.value = status;
    detectedSheets.value = detected.sheets || [];
    includeSheetIds.value = [...(detected.includeIds || [])];
  } catch {
    googleStatus.value = null;
  }
}

async function toggleIncludeSheet(spreadsheetId: string, checked: boolean) {
  const id = props.selectedJobId;
  if (!id) return;
  const next = new Set(includeSheetIds.value);
  if (checked) next.add(spreadsheetId);
  else next.delete(spreadsheetId);
  includeSheetIds.value = [...next];
  includeSaving.value = true;
  try {
    const res = await jobApi.googleInclude(id, includeSheetIds.value);
    includeSheetIds.value = res.includeIds || includeSheetIds.value;
    await work.loadJobs().catch(() => undefined);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
    await refreshGoogleStatus();
  } finally {
    includeSaving.value = false;
  }
}

async function reloadJob() {
  await work.loadJobs().catch(() => undefined);
  if (props.selectedJobId) {
    await work.selectJob(props.selectedJobId).catch(() => undefined);
  }
  await refreshGoogleStatus();
}

async function authorizeGoogle() {
  const id = props.selectedJobId;
  if (!id) return;
  googleBusy.value = true;
  autoContinueAfterAuth.value = awaitingGoogleAuth.value;
  try {
    const { authUrl, configured } = await jobApi.googleAuthUrl(id);
    if (!configured || !authUrl) {
      message.error("Google OAuth is not configured on the server");
      return;
    }
    const popup = window.open(
      authUrl,
      "flow-google-oauth",
      "width=520,height=720,menubar=no,toolbar=no",
    );
    if (!popup) {
      message.warning("Popup blocked — allow popups for this site");
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    googleBusy.value = false;
  }
}

async function continueAfterGoogle() {
  const id = props.selectedJobId;
  if (!id) return;
  googleBusy.value = true;
  try {
    const res = await jobApi.googleContinue(id);
    if (!res.enqueued && !res.ok) {
      message.warning(res.reason || "Could not enqueue job");
    } else {
      message.success("Continue Run — job queued");
    }
    await reloadJob();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    googleBusy.value = false;
  }
}

async function revokeGoogle() {
  const id = props.selectedJobId;
  if (!id) return;
  googleBusy.value = true;
  try {
    await jobApi.googleRevoke(id);
    message.success("Google access revoked for this task");
    await reloadJob();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    googleBusy.value = false;
  }
}

function onGoogleOAuthMessage(ev: MessageEvent) {
  const d = ev.data as {
    type?: string;
    ok?: boolean;
    jobId?: string | null;
    message?: string;
  } | null;
  if (!d || d.type !== "flow-google-oauth") return;
  if (d.jobId && props.selectedJobId && d.jobId !== props.selectedJobId) {
    return;
  }
  if (d.ok) {
    message.success(d.message || "Google authorized");
    void (async () => {
      await reloadJob();
      if (autoContinueAfterAuth.value) {
        autoContinueAfterAuth.value = false;
        await continueAfterGoogle();
      }
    })();
  } else {
    message.error(d.message || "Google authorization failed");
  }
}

watch(
  () => [
    props.selectedJobId,
    props.currentJob?.status,
    props.currentJob?.googleAuth?.email,
  ],
  () => {
    void refreshGoogleStatus();
  },
  { immediate: true },
);

watch(
  () => props.notesSaving,
  (saving, wasSaving) => {
    if (wasSaving && !saving) void refreshGoogleStatus();
  },
);

onMounted(() => {
  window.addEventListener("message", onGoogleOAuthMessage);
});
onUnmounted(() => {
  window.removeEventListener("message", onGoogleOAuthMessage);
});
</script>

<template>
  <section
    class="flex flex-col min-h-0 overflow-hidden relative h-full faw-mid-col"
  >
    <div
      v-if="jobLoading"
      class="absolute inset-0 z-20 bg-surface p-4 space-y-2"
      aria-busy="true"
    >
      <div class="skel h-5 w-48" />
      <div class="skel h-3 w-full" />
      <div class="skel h-3 w-[92%]" />
      <div class="skel h-24 w-full mt-2" />
      <div class="skel h-3 w-3/4" />
      <div class="skel h-3 w-2/3" />
      <div class="skel h-16 w-full mt-1.5" />
    </div>

    <a-tabs
      v-show="!jobLoading"
      :activeKey="midTab"
      class="work-tabs flex-1 min-h-0"
      @update:activeKey="(k: string) => emit('update:midTab', k as MidTab)"
    >
      <a-tab-pane key="detail" tab="Issue">
        <div
          class="faw-issue-scroll"
          :class="hideStickyActions ? '' : 'pb-4'"
        >
          <template v-if="taskDetail || currentJob">
            <a-alert
              v-if="isCurrentAdhoc"
              type="info"
              show-icon
              class="mb-3"
              message="Hotfix session — no GitLab issue yet"
            >
              <template #action>
                <a-button
                  size="small"
                  type="primary"
                  :loading="issueCreateBusy"
                  @click="emit('openCreateIssue')"
                  >Create GitLab issue</a-button
                >
              </template>
            </a-alert>

            <a-alert
              v-if="awaitingDocsApproval"
              type="success"
              show-icon
              class="mb-3"
              message="Docs phase complete — approve to run code"
            >
              <template #action>
                <a-button
                  size="small"
                  type="primary"
                  :loading="approveDocsBusy"
                  @click="emit('approveDocs')"
                  >Approve Docs</a-button
                >
              </template>
            </a-alert>

            <a-alert
              v-if="awaitingGoogleAuth"
              type="warning"
              show-icon
              class="mb-3"
              message="Authorize Google to read linked Sheets"
              description="Task có link Google Sheets. Cấp quyền đọc (readonly), rồi Continue Run."
            >
              <template #action>
                <div class="flex flex-col gap-1.5 items-end">
                  <a-button
                    size="small"
                    type="primary"
                    :loading="googleBusy"
                    @click="authorizeGoogle"
                    >Authorize Google</a-button
                  >
                  <a-button
                    size="small"
                    :loading="googleBusy"
                    :disabled="!googleStatus?.authorized"
                    @click="continueAfterGoogle"
                    >Continue Run</a-button
                  >
                </div>
              </template>
            </a-alert>

            <div
              v-if="showGoogleCard && !awaitingGoogleAuth"
              class="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-ink-soft"
            >
              <span v-if="googleStatus?.authorized || currentJob?.googleAuth?.email">
                Google Sheets:
                {{
                  googleStatus?.email ||
                  currentJob?.googleAuth?.email ||
                  "linked"
                }}
              </span>
              <a-button
                v-if="googleStatus?.authorized || currentJob?.googleAuth?.email"
                size="small"
                danger
                type="link"
                class="!px-0"
                :loading="googleBusy"
                @click="revokeGoogle"
                >Revoke</a-button
              >
            </div>

            <div class="faw-issue-head">
              <template v-if="isCurrentAdhoc">
                <span class="faw-issue-head__num">Hotfix</span>
                <h1 class="faw-issue-head__title">{{ detailTitle }}</h1>
              </template>
              <template v-else>
                <span class="faw-issue-head__num">
                  <IssueIidLink
                    :iid="
                      taskDetail?.issueIid ||
                      currentJob?.issue?.issueIid ||
                      selectedTaskIid
                    "
                    :url="taskDetail?.url || currentJob?.issue?.url"
                    link-class="!text-[14px] !font-mono !text-ink-faint"
                  />
                </span>
                <h1 class="faw-issue-head__title">{{ detailTitle }}</h1>
              </template>
            </div>

            <div
              v-if="
                (currentJob && jobBranch(currentJob)) ||
                currentJob?.commitSha ||
                detailMeta
              "
              class="meta-line"
            >
              <template v-if="currentJob && jobBranch(currentJob)">
                <span class="meta-line__branch font-mono">
                  <span class="truncate max-w-[16rem]">{{
                    jobBranch(currentJob)
                  }}</span>
                  <button
                    type="button"
                    class="meta-line__copy"
                    title="Copy branch"
                    @click="emit('copyBranch', jobBranch(currentJob))"
                  >
                    <CopyOutlined class="text-[10px]" />
                  </button>
                </span>
              </template>
              <code v-if="currentJob?.commitSha">{{
                currentJob.commitSha.slice(0, 8)
              }}</code>
              <template v-if="detailMeta">
                <span class="meta-line__sep">·</span>
                <span class="meta-line__detail">{{ detailMeta }}</span>
              </template>
            </div>

            <div class="faw-ctx-tags">
              <span
                v-if="contextQuality?.level === 'good'"
                class="faw-pill faw-pill--good"
                :title="contextQuality.reason || ''"
                >✓ {{ contextQualityLabel(contextQuality.level) }}</span
              >
              <a-tag
                v-else-if="contextQuality?.level"
                :color="contextQualityColor(contextQuality.level)"
                class="m-0 !text-[10px] !leading-none !px-1.5 !py-0.5"
                :title="contextQuality.reason || ''"
                >{{ contextQualityLabel(contextQuality.level) }}</a-tag
              >
              <button
                type="button"
                class="faw-pill faw-pill--link"
                @click="emit('openStandards')"
              >
                View standards
              </button>
              <template v-if="!isCurrentAdhoc && taskDetail?.labels?.length">
                <span
                  v-for="l in taskDetail.labels"
                  :key="l"
                  class="faw-chip"
                  >{{ l }}</span
                >
              </template>
            </div>

            <a-alert
              v-if="contextIsBad"
              type="error"
              show-icon
              class="mb-3"
              message="Bad Context — Run blocked"
              :description="
                currentJob?.lastQuestion ||
                'Add Dev Notes or technical details, then Run again.'
              "
            />

            <div class="faw-issue-body">
              <ChatMessageBody
                v-if="isCurrentAdhoc"
                role="agent"
                :markdown="true"
                :body="
                  currentJob?.summary?.trim() ||
                  'No summary yet — chat with the agent or describe the work.'
                "
              />
              <ChatMessageBody
                v-else
                role="agent"
                :markdown="true"
                :issue-url="taskDetail?.url || currentJob?.issue?.url"
                :body="taskDetail?.description || ''"
                empty="(no description)"
              />
            </div>

            <template v-if="!isCurrentAdhoc">
              <div>
                <h3 class="faw-sec">
                  Related / child
                  <span v-if="relatedIssues.length"
                    >({{ relatedIssues.length }})</span
                  >
                </h3>
                <ul v-if="relatedIssues.length" class="m-0 mb-2.5 pl-[18px] text-[12.5px] text-ink-muted leading-[1.7]">
                  <li
                    v-for="r in relatedIssues"
                    :key="r.iid"
                    class="mb-1"
                  >
                    <button
                      type="button"
                      class="text-left text-accent hover:underline bg-transparent border-0 p-0 cursor-pointer font-[inherit] text-[12.5px]"
                      @click="
                        emit('openRelated', {
                          iid: r.iid,
                          title: r.title,
                          url: r.url,
                        })
                      "
                    >
                      <IssueIidLink :iid="r.iid" :url="r.url" />
                      — {{ r.title }}
                    </button>
                    <div class="text-[11px] text-ink-faint">
                      {{ r.state }} · {{ r.source
                      }}{{ r.linkType ? ` · ${r.linkType}` : "" }}
                    </div>
                  </li>
                </ul>
                <div v-else class="text-[11px] text-ink-faint mb-2">
                  No related / child issues
                </div>
              </div>

              <div>
                <h3 class="faw-sec">
                  Comments
                  <span v-if="humanComments.length"
                    >({{ humanComments.length }})</span
                  >
                </h3>
                <div v-if="humanComments.length" class="space-y-3">
                  <div v-for="n in humanComments" :key="n.id">
                    <div class="text-[11px] text-ink-faint mb-1">
                      @{{ n.author }}
                      <span v-if="n.createdAt">
                        · {{ new Date(n.createdAt).toLocaleString() }}</span
                      >
                    </div>
                    <ChatMessageBody
                      class="faw-issue-body"
                      role="agent"
                      :markdown="true"
                      :issue-url="taskDetail?.url || currentJob?.issue?.url"
                      :body="n.body"
                    />
                  </div>
                </div>
                <div v-else class="text-[11px] text-ink-faint">No comments yet</div>
              </div>
            </template>

            <div>
              <h3 class="faw-sec">
                Dev Notes
                <a-button
                  size="small"
                  type="link"
                  class="!px-0 !h-auto !text-[10px] !ml-1"
                  @click="emit('openStandards')"
                  >standards</a-button
                >
                <span
                  v-if="notesSaving"
                  class="text-[10px] text-ink-faint font-normal normal-case tracking-normal"
                  >saving…</span
                >
                <span class="flex-1" />
                <a-button
                  size="small"
                  type="primary"
                  :loading="notesSaving"
                  title="⌘/Ctrl+S"
                  @click="emit('saveNotes')"
                  >Save</a-button
                >
              </h3>
              <a-textarea
                :value="notesDraft"
                :rows="4"
                placeholder="Clear technical guidance (≥ ~25 words + file/route/field…) → Good Context"
                @update:value="
                  (v: string) => {
                    emit('update:notesDraft', v);
                    emit('notesInput');
                  }
                "
              />
              <div class="mt-2 flex items-center gap-1.5">
                <a-switch
                  :checked="requireDocsFirst"
                  size="small"
                  @update:checked="
                    (v: boolean) => emit('update:requireDocsFirst', v)
                  "
                />
                <span class="text-[11px] text-ink-muted"
                  >Docs-first (read docs before coding)</span
                >
              </div>

              <div
                v-if="detectedSheets.length"
                class="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-2.5"
              >
                <div class="text-[12px] text-ink-soft font-medium">
                  Đọc Google Sheets / Excel khi Run
                </div>
                <div class="text-[11px] text-ink-muted mt-0.5 mb-2">
                  Mặc định tắt. Tick file cần đưa vào agent context (tối đa ~200
                  dòng / file).
                </div>
                <div class="space-y-1.5">
                  <label
                    v-for="s in detectedSheets"
                    :key="s.spreadsheetId"
                    class="flex items-start gap-2 text-[12px] text-ink-soft cursor-pointer"
                  >
                    <a-checkbox
                      :checked="includeSheetIds.includes(s.spreadsheetId)"
                      :disabled="includeSaving || busy"
                      @change="
                        (e: { target: { checked: boolean } }) =>
                          toggleIncludeSheet(
                            s.spreadsheetId,
                            e.target.checked,
                          )
                      "
                    />
                    <span class="min-w-0">
                      <span class="font-medium">{{ sheetLabel(s) }}</span>
                      <a
                        :href="s.url"
                        target="_blank"
                        rel="noopener"
                        class="block text-[10px] text-ink-faint truncate hover:underline"
                        @click.stop
                        >{{ s.url }}</a
                      >
                    </span>
                  </label>
                </div>
              </div>
            </div>
          </template>
          <a-empty v-else description="Select a task or job">
            <span class="text-[11px] text-ink-faint"
              >Select on the left column to view context and Run</span
            >
          </a-empty>
        </div>
      </a-tab-pane>

      <a-tab-pane key="diff" :disabled="!selectedJobId">
        <template #tab>
          <span class="inline-flex items-center gap-1.5">
            Diff
            <span
              v-if="currentJob?.hasPendingChanges"
              class="inline-flex items-center justify-center min-w-[1.1rem] h-4 px-1 rounded text-[10px] font-bold bg-amber-500/25 text-amber-300"
              title="Uncommitted changes"
              >WIP</span
            >
          </span>
        </template>
        <div class="h-full min-h-0 flex flex-col overflow-hidden p-3">
          <div
            v-if="showGoogleCard"
            class="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-soft shrink-0"
          >
            <span v-if="awaitingGoogleAuth">Awaiting Google Sheets auth</span>
            <span v-else-if="googleStatus?.email || currentJob?.googleAuth?.email">
              Google Sheets:
              {{ googleStatus?.email || currentJob?.googleAuth?.email }}
            </span>
            <a-button
              v-if="awaitingGoogleAuth"
              size="small"
              type="primary"
              :loading="googleBusy"
              @click="authorizeGoogle"
              >Authorize Google</a-button
            >
            <a-button
              v-else-if="googleStatus?.authorized || currentJob?.googleAuth?.email"
              size="small"
              danger
              type="link"
              class="!px-0"
              :loading="googleBusy"
              @click="revokeGoogle"
              >Revoke</a-button
            >
          </div>
          <JobDiffPanel
            class="flex-1 min-h-0"
            :job-id="selectedJobId"
            :branch="currentJob ? jobBranch(currentJob) : null"
            :issue-iid="currentJob?.issue?.issueIid ?? null"
            :issue-title="currentJob?.issue?.title ?? detailTitle"
            @updated="emit('diffUpdated')"
          />
        </div>
      </a-tab-pane>
    </a-tabs>

    <!-- Bottom bar — mockup bottombar -->
    <div
      v-show="!jobLoading && !hideStickyActions && midTab === 'detail'"
      class="faw-bottombar"
      :class="mobileTouch ? '!gap-3' : ''"
    >
      <a-tooltip :title="runBlockedReason || 'Run agent on selected task'">
        <button
          type="button"
          class="faw-btn faw-btn--run"
          :class="mobileTouch ? '!min-h-[44px]' : ''"
          :disabled="busy || Boolean(runBlockedReason)"
          @click="emit('runSelected')"
        >
          ▶ Run
        </button>
      </a-tooltip>
      <button
        v-if="awaitingDocsApproval"
        type="button"
        class="faw-btn faw-btn--run"
        :class="mobileTouch ? '!min-h-[44px]' : ''"
        :disabled="approveDocsBusy"
        @click="emit('approveDocs')"
      >
        Approve Docs
      </button>
      <a-tooltip
        :title="
          canSyncBase
            ? 'Pull base mới nhất vào nhánh job (AI tự fix conflict)'
            : 'Chỉ khi job có branch và không đang chạy'
        "
      >
        <button
          type="button"
          class="faw-btn"
          :class="mobileTouch ? '!min-h-[44px]' : ''"
          :disabled="!canSyncBase || syncBaseBusy"
          @click="emit('syncBase')"
        >
          {{ syncBaseBusy ? "Syncing…" : "⇣ Sync base" }}
        </button>
      </a-tooltip>
      <a-tooltip
        :title="
          canCreateMr
            ? currentJob?.mrUrl
              ? 'Open existing / refresh MR'
              : 'Create open MR (no merge) + Ready to Release'
            : 'Need handoff/done, branch, and no pending changes'
        "
      >
        <button
          type="button"
          class="faw-btn"
          :class="mobileTouch ? '!min-h-[44px]' : ''"
          :disabled="!canCreateMr || createMrBusy || mergeBusy || handoffBusy"
          @click="emit('createMr')"
        >
          {{ createMrBusy ? "MR…" : currentJob?.mrUrl ? "MR ✓" : "Create MR" }}
        </button>
      </a-tooltip>
      <a-popconfirm
        title="Merge work branch → base?"
        ok-text="Merge"
        cancel-text="Cancel"
        :disabled="!canQuickMerge || mergeBusy"
        @confirm="emit('quickMerge')"
      >
        <a-tooltip
          :title="
            canQuickMerge
              ? 'Quick merge (work → base)'
              : 'Only when job is Awaiting handoff / Done'
          "
        >
          <button
            type="button"
            class="faw-btn"
            :class="mobileTouch ? '!min-h-[44px]' : ''"
            :disabled="!canQuickMerge || mergeBusy || handoffBusy || createMrBusy"
          >
            Merge
          </button>
        </a-tooltip>
      </a-popconfirm>
      <a-popconfirm
        title="Handoff with Settings prefs (assignee / labels)?"
        ok-text="Handoff"
        cancel-text="Cancel"
        :disabled="!canQuickHandoff || handoffBusy"
        @confirm="emit('quickHandoff')"
      >
        <a-tooltip
          :title="
            canQuickHandoff
              ? 'Quick handoff (Settings → Labels)'
              : 'Only when job is Awaiting handoff / Done'
          "
        >
          <button
            type="button"
            class="faw-btn"
            :class="mobileTouch ? '!min-h-[44px]' : ''"
            :disabled="!canQuickHandoff || handoffBusy || mergeBusy || createMrBusy"
          >
            Handoff
          </button>
        </a-tooltip>
      </a-popconfirm>
    </div>
  </section>
</template>
