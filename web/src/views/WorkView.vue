<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { useSessionStore } from "@/stores/session";
import { useWorkStore } from "@/stores/work";
import { statusLabel } from "@/utils/status";

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
} = storeToRefs(work);

const midTab = ref("detail");
const selectedIids = ref<number[]>([]);
const chatInput = ref("");
const clarifyInput = ref("");
const busy = ref(false);
const notesSaving = ref(false);
const notesDraft = ref("");
const requireDocsFirst = ref(false);
const milestoneFilter = ref<string>("all");

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

const humanComments = computed(() =>
  (taskDetail.value?.notes || []).filter((n) => !n.system && n.body?.trim()),
);

const relatedIssues = computed(() => taskDetail.value?.related || []);

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

async function onSelectTask(iid: number) {
  midTab.value = "detail";
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
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
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
    message.success("Đã enqueue");
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
    message.success("Đã enqueue all");
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
  busy.value = true;
  try {
    if (mode === "continue") await work.sendContinue(msg);
    else await work.sendAsk(msg);
    chatInput.value = "";
    midTab.value = "progress";
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
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
    await work.selectJob(selectedJobId.value);
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
</script>

<template>
  <div
    class="h-full max-h-full grid grid-cols-12 gap-3 p-3 min-h-0 overflow-hidden"
  >
    <!-- Left: tasks + jobs -->
    <aside
      class="col-span-3 flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel"
    >
      <div class="shrink-0 p-3 border-b border-line space-y-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-semibold text-ink">Tasks</span>
          <div class="flex gap-1">
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
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        <a-spin :spinning="loading">
          <div
            v-for="t in filteredTasks"
            :key="t.issueIid"
            class="rounded-xl px-2.5 py-2 cursor-pointer hover:bg-surface-muted border border-transparent transition"
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

      <div
        class="shrink-0 border-t border-line p-2 h-[32%] min-h-[140px] max-h-[40%] overflow-y-auto bg-surface-soft/80"
      >
        <div
          class="text-xs font-semibold uppercase tracking-wide text-ink-faint px-1 mb-1 sticky top-0 bg-surface-soft/95 py-1"
        >
          Jobs
        </div>
        <div
          v-for="j in jobs"
          :key="j.id"
          class="rounded-lg px-2 py-1.5 mb-1 cursor-pointer hover:bg-surface-raised text-sm border border-transparent relative"
          :class="
            selectedJobId === j.id
              ? '!bg-surface-raised !border-line shadow-sm'
              : ''
          "
          @click="onSelectJob(j.id)"
        >
          <div class="flex items-center gap-2">
            <a-tag :color="statusColor(j.status)" class="m-0 text-[10px]">{{
              statusLabel(j.status)
            }}</a-tag>
            <span class="text-accent text-xs font-semibold"
              >#{{ j.issue?.issueIid }}</span
            >
            <a-spin
              v-if="jobLoading && selectedJobId === j.id"
              size="small"
              class="ml-auto"
            />
          </div>
          <div class="truncate text-ink-muted text-xs mt-0.5">
            {{ j.issue?.title }}
          </div>
        </div>
      </div>
    </aside>

    <!-- Mid: tabs -->
    <section
      class="col-span-5 flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel relative"
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
              <div>
                <h2 class="text-base font-semibold text-ink mt-2 mb-1">
                  <a
                    v-if="taskDetail?.url"
                    :href="taskDetail.url"
                    target="_blank"
                    rel="noopener"
                    class="text-accent hover:underline"
                    >#{{ taskDetail.issueIid || selectedTaskIid }}</a
                  >
                  <span v-else
                    >#{{
                      taskDetail?.issueIid ||
                      currentJob?.issue?.issueIid ||
                      selectedTaskIid
                    }}</span
                  >
                  {{ detailTitle }}
                </h2>
                <p v-if="detailMeta" class="text-xs text-ink-faint m-0 mb-2">
                  {{ detailMeta }}
                </p>
                <div
                  v-if="taskDetail?.labels?.length"
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
                  class="text-sm text-ink-soft whitespace-pre-wrap rounded-xl bg-surface-soft border border-line p-3"
                >
                  {{
                    taskDetail?.description?.trim() || "(không có description)"
                  }}
                </div>
              </div>

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
                    @click="onSelectTask(r.iid)"
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
                    <div class="text-sm text-ink-soft whitespace-pre-wrap">
                      {{ n.body }}
                    </div>
                  </div>
                </div>
                <div v-else class="text-xs text-ink-faint">Chưa có comment</div>
              </div>

              <div class="rounded-xl border border-line bg-accent-soft/30 p-3">
                <div class="flex items-center justify-between gap-2 mb-2">
                  <div
                    class="text-xs font-semibold uppercase tracking-wide text-accent"
                  >
                    Dev Notes
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
                  placeholder="Chỉ dẫn kỹ thuật… vd. virtual scroll, index user_id…"
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
              <div class="text-ink-soft">{{ l.text }}</div>
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
      class="col-span-4 flex flex-col min-h-0 overflow-hidden rounded-2xl panel-glass shadow-panel relative"
    >
      <div
        v-if="jobLoading"
        class="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-surface-raised/55 backdrop-blur-[2px]"
      >
        <a-spin size="large" tip="Đang tải chat…" />
      </div>
      <div
        class="shrink-0 px-3 py-2.5 border-b border-line flex items-center justify-between bg-gradient-to-r from-accent-soft/60 to-transparent"
      >
        <span class="font-semibold text-sm text-ink">Chat agent</span>
        <a-tag v-if="currentJob" :color="statusColor(currentJob.status)">{{
          statusLabel(currentJob.status)
        }}</a-tag>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
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
          <div class="whitespace-pre-wrap">{{ m.body }}</div>
        </div>
        <a-empty v-if="!chat.length" description="Chat trống — Run hoặc Gửi" />
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
          placeholder="Hỏi / sửa / làm thêm (IDE follow-up)…"
          @keydown.meta.enter="sendChat('continue')"
        />
        <div class="flex gap-2">
          <a-button
            type="primary"
            class="flex-1"
            :loading="busy"
            @click="sendChat('continue')"
            >Gửi</a-button
          >
          <a-button :loading="busy" @click="sendChat('ask')">Chỉ hỏi</a-button>
        </div>
      </div>
    </aside>
  </div>
</template>
