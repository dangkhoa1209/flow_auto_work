<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  SwapOutlined,
} from "@ant-design/icons-vue";
import { storeToRefs } from "pinia";
import { api } from "@/api/client";
import IssueIidLink from "@/components/IssueIidLink.vue";
import ChatMessageBody from "@/components/ChatMessageBody.vue";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useWorkStore } from "@/stores/work";

const session = useSessionStore();
const work = useWorkStore();
const settings = useSettingsStore();
const { jobs, members, labels } = storeToRefs(work);

const selectedId = ref<string | null>(null);
const busy = ref(false);
const listLoading = ref(false);
const assignee = ref<string | undefined>(
  settings.local.assignee || undefined,
);
const addLabels = ref<string[]>([...settings.local.addLabels]);
const comment = ref(settings.local.comment);

const handoffJobs = computed(() =>
  jobs.value
    .filter((j) => j.status === "awaiting_handoff")
    .slice()
    .sort((a, b) => {
      const ub = Date.parse(b.updatedAt || "") || 0;
      const ua = Date.parse(a.updatedAt || "") || 0;
      if (ub !== ua) return ub - ua;
      const cb = Date.parse(b.createdAt || "") || 0;
      const ca = Date.parse(a.createdAt || "") || 0;
      return cb - ca;
    }),
);

const selected = computed(
  () => jobs.value.find((j) => j.id === selectedId.value) || null,
);

onMounted(async () => {
  await settings.loadHandoffPrefs(session.projectId).catch(() => undefined);
  assignee.value = settings.local.assignee || undefined;
  addLabels.value = [...settings.local.addLabels];
  comment.value = settings.local.comment;
  await refreshJobs();
  await work.loadMeta();
});

async function refreshJobs() {
  listLoading.value = true;
  try {
    await work.loadJobs();
  } finally {
    listLoading.value = false;
  }
}

function selectJob(id: string) {
  selectedId.value = id;
}

function backToList() {
  selectedId.value = null;
}

async function confirmHandoff() {
  if (!selectedId.value) return;
  busy.value = true;
  try {
    await api(`/api/jobs/${selectedId.value}/completion-actions`, {
      method: "POST",
      body: JSON.stringify({
        assignees: assignee.value ? [assignee.value] : [],
        labels: addLabels.value,
        removeLabels: settings.local.removeLabels || [],
        comment: comment.value || undefined,
        labelMode: "add",
      }),
    });
    message.success("Handoff OK");
    selectedId.value = null;
    await Promise.all([work.loadJobs(), work.loadTasks()]);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function skipHandoff() {
  if (!selectedId.value) return;
  busy.value = true;
  try {
    await work.setJobStatus(selectedId.value, "succeeded");
    message.success("Marked Done — skipped GitLab handoff");
    selectedId.value = null;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function mergeBranch() {
  if (!selectedId.value) return;
  busy.value = true;
  try {
    const res = await api<{
      merge?: {
        aiResolved?: boolean;
        source?: string;
        target?: string;
        wipWarning?: string;
      };
    }>(`/api/jobs/${selectedId.value}/merge`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const m = res?.merge;
    const mergeBranches =
      m?.source && m?.target
        ? `${m.source} → ${m.target}`
        : m?.target || m?.source || "";
    if (m?.aiResolved) {
      message.success(
        mergeBranches
          ? `Merged ${mergeBranches} — AI auto-resolved conflicts`
          : "Merge OK — AI auto-resolved conflicts",
      );
    } else {
      message.success(mergeBranches ? `Merged ${mergeBranches}` : "Merge OK");
    }
    if (m?.wipWarning) message.warning(m.wipWarning, 8);
    await work.loadJobs();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="faw-handoff">
    <!-- Desktop -->
    <div class="faw-handoff__shell hidden lg:flex">
      <header class="faw-handoff__hero">
        <div>
          <p class="faw-handoff__eyebrow">
            <SwapOutlined aria-hidden="true" />
            QC pipeline
          </p>
          <h1 class="faw-handoff__title">Task handoff</h1>
          <p class="faw-handoff__desc">
            Review completed agent runs and push assignees, labels, and comments
            to GitLab — or merge and mark done without handoff.
          </p>
        </div>
        <div class="faw-handoff__kpis">
          <div class="faw-handoff__kpi faw-handoff__kpi--accent">
            <span class="faw-handoff__kpi-label">Awaiting</span>
            <span class="faw-handoff__kpi-value">{{ handoffJobs.length }}</span>
          </div>
          <a-button
            size="small"
            :loading="listLoading"
            @click="refreshJobs"
          >
            <template #icon><ReloadOutlined /></template>
            Refresh
          </a-button>
        </div>
      </header>

      <div class="faw-handoff__grid">
        <aside class="faw-handoff__panel">
          <div class="faw-handoff__panel-head">Done awaiting handoff</div>
          <div class="faw-handoff__panel-body">
            <button
              v-for="j in handoffJobs"
              :key="j.id"
              type="button"
              class="faw-handoff__job"
              :class="{ 'is-active': selectedId === j.id }"
              @click="selectJob(j.id)"
            >
              <div class="text-xs">
                <IssueIidLink
                  :iid="j.issue?.issueIid"
                  :url="j.issue?.url"
                  link-class="!text-xs"
                />
              </div>
              <div class="faw-handoff__job-title truncate">
                {{ j.issue?.title }}
              </div>
              <div v-if="j.summary?.trim()" class="faw-handoff-list-summary mt-1">
                <ChatMessageBody
                  role="agent"
                  :markdown="true"
                  :issue-url="j.issue?.url"
                  :body="j.summary"
                />
              </div>
              <div v-else class="text-[11px] text-ink-faint mt-1 truncate">
                {{ j.branch || j.id }}
              </div>
            </button>
            <div v-if="!handoffJobs.length && !listLoading" class="faw-handoff__empty">
              <CheckCircleOutlined class="faw-handoff__empty-icon" aria-hidden="true" />
              <p class="m-0 font-medium text-ink">All caught up</p>
              <p class="m-0 text-xs">No jobs awaiting handoff right now.</p>
            </div>
            <a-spin v-if="listLoading && !handoffJobs.length" class="block py-8" />
          </div>
        </aside>

        <section class="faw-handoff__panel">
          <div class="faw-handoff__panel-head">Handoff details</div>
          <div class="faw-handoff__panel-body">
            <template v-if="selected">
              <h2 class="faw-handoff__detail-title">
                <IssueIidLink
                  :iid="selected.issue?.issueIid"
                  :url="selected.issue?.url"
                />
                — {{ selected.issue?.title }}
              </h2>
              <div class="faw-handoff-detail-summary mb-4">
                <ChatMessageBody
                  role="agent"
                  :markdown="true"
                  :issue-url="selected.issue?.url"
                  :body="selected.summary || ''"
                  empty="—"
                />
              </div>
              <a-form layout="vertical" class="max-w-lg">
                <a-form-item label="Assign">
                  <a-select
                    v-model:value="assignee"
                    allow-clear
                    show-search
                    class="w-full"
                    :options="
                      members.map((m) => ({
                        value: m.username,
                        label: `@${m.username}`,
                      }))
                    "
                  />
                </a-form-item>
                <a-form-item label="Add labels">
                  <a-select
                    v-model:value="addLabels"
                    mode="multiple"
                    class="w-full"
                    :options="labels.map((l) => ({ value: l, label: l }))"
                  />
                </a-form-item>
                <a-form-item label="Comment">
                  <a-textarea v-model:value="comment" :rows="2" />
                </a-form-item>
                <div class="faw-handoff__actions">
                  <a-button :loading="busy" @click="mergeBranch">
                    Merge → project
                  </a-button>
                  <a-popconfirm
                    title="Mark Done without GitLab assign/labels?"
                    description="Skips assignee and label updates on GitLab. Use for hotfixes or tasks that do not need handoff."
                    ok-text="Mark Done"
                    cancel-text="Cancel"
                    :disabled="busy"
                    @confirm="skipHandoff"
                  >
                    <a-button :disabled="busy">Done — skip handoff</a-button>
                  </a-popconfirm>
                  <a-button type="primary" :loading="busy" @click="confirmHandoff">
                    Confirm handoff
                  </a-button>
                </div>
              </a-form>
            </template>
            <div v-else class="faw-handoff__empty">
              <SwapOutlined class="faw-handoff__empty-icon" aria-hidden="true" />
              <p class="m-0">Select a job from the queue to review and hand off.</p>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- Mobile -->
    <div class="lg:hidden flex flex-col h-full min-h-0">
      <div
        v-show="!selectedId"
        class="flex flex-col flex-1 min-h-0 overflow-hidden"
      >
        <header class="faw-handoff__hero shrink-0 mx-3 mt-3">
          <div>
            <p class="faw-handoff__eyebrow">
              <SwapOutlined aria-hidden="true" />
              QC pipeline
            </p>
            <h1 class="faw-handoff__title">Task handoff</h1>
          </div>
          <div class="faw-handoff__kpis">
            <div class="faw-handoff__kpi faw-handoff__kpi--accent">
              <span class="faw-handoff__kpi-label">Awaiting</span>
              <span class="faw-handoff__kpi-value">{{ handoffJobs.length }}</span>
            </div>
          </div>
        </header>
        <div class="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          <button
            v-for="j in handoffJobs"
            :key="j.id"
            type="button"
            class="faw-handoff-card touch-manipulation"
            @click="selectJob(j.id)"
          >
            <div class="text-xs">
              <IssueIidLink
                :iid="j.issue?.issueIid"
                :url="j.issue?.url"
                link-class="!text-xs"
              />
            </div>
            <div class="text-sm text-ink font-medium truncate mt-0.5">
              {{ j.issue?.title }}
            </div>
            <div v-if="j.summary?.trim()" class="faw-handoff-list-summary mt-1">
              <ChatMessageBody
                role="agent"
                :markdown="true"
                :issue-url="j.issue?.url"
                :body="j.summary"
              />
            </div>
            <div v-else class="text-[11px] text-ink-faint mt-1 truncate">
              {{ j.branch || j.id }}
            </div>
          </button>
          <div v-if="!handoffJobs.length" class="faw-handoff__empty">
            <CheckCircleOutlined class="faw-handoff__empty-icon" aria-hidden="true" />
            <p class="m-0">No jobs awaiting handoff</p>
          </div>
        </div>
      </div>

      <div
        v-show="selectedId"
        class="flex flex-col flex-1 min-h-0 overflow-hidden"
      >
        <div class="faw-m-detail-bar shrink-0">
          <button
            type="button"
            class="faw-m-detail-bar__back touch-manipulation"
            title="Back"
            @click="backToList"
          >
            <ArrowLeftOutlined />
          </button>
          <div class="faw-m-detail-bar__title min-w-0">
            <div class="faw-m-detail-bar__name truncate">
              <IssueIidLink
                v-if="selected"
                :iid="selected.issue?.issueIid"
                :url="selected.issue?.url"
                link-class="!text-[12px] shrink-0 mr-1"
              />
              <span>{{ selected?.issue?.title || "—" }}</span>
            </div>
          </div>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          <template v-if="selected">
            <div class="faw-handoff-detail-summary m-0 mb-3">
              <ChatMessageBody
                role="agent"
                :markdown="true"
                :issue-url="selected.issue?.url"
                :body="selected.summary || ''"
                empty="—"
              />
            </div>
            <a-form layout="vertical" class="faw-handoff-form">
              <a-form-item label="Assign">
                <a-select
                  v-model:value="assignee"
                  allow-clear
                  show-search
                  class="w-full"
                  :options="
                    members.map((m) => ({
                      value: m.username,
                      label: `@${m.username}`,
                    }))
                  "
                />
              </a-form-item>
              <a-form-item label="Add labels">
                <a-select
                  v-model:value="addLabels"
                  mode="multiple"
                  class="w-full"
                  :options="labels.map((l) => ({ value: l, label: l }))"
                />
              </a-form-item>
              <a-form-item label="Comment">
                <a-textarea v-model:value="comment" :rows="2" />
              </a-form-item>
              <div class="faw-handoff-actions">
                <button
                  type="button"
                  class="faw-m-btn faw-m-btn--handoff touch-manipulation"
                  :disabled="busy"
                  @click="mergeBranch"
                >
                  {{ busy ? "…" : "Merge" }}
                </button>
                <a-popconfirm
                  title="Mark Done without GitLab assign/labels?"
                  description="Skips assignee and label updates on GitLab."
                  ok-text="Mark Done"
                  cancel-text="Cancel"
                  :disabled="busy"
                  @confirm="skipHandoff"
                >
                  <button
                    type="button"
                    class="faw-m-btn faw-m-btn--handoff touch-manipulation"
                    :disabled="busy"
                  >
                    {{ busy ? "…" : "Skip handoff" }}
                  </button>
                </a-popconfirm>
                <button
                  type="button"
                  class="faw-m-btn faw-m-btn--primary touch-manipulation"
                  :disabled="busy"
                  @click="confirmHandoff"
                >
                  {{ busy ? "…" : "Confirm handoff" }}
                </button>
              </div>
            </a-form>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
