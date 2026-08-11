<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { ArrowLeftOutlined } from "@ant-design/icons-vue";
import { storeToRefs } from "pinia";
import { api } from "@/api/client";
import IssueIidLink from "@/components/IssueIidLink.vue";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useWorkStore } from "@/stores/work";

const session = useSessionStore();
const work = useWorkStore();
const settings = useSettingsStore();
const { jobs, members, labels } = storeToRefs(work);

const selectedId = ref<string | null>(null);
const busy = ref(false);
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
  await work.loadJobs();
  await work.loadMeta();
});

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

async function mergeBranch() {
  if (!selectedId.value) return;
  busy.value = true;
  try {
    await api(`/api/jobs/${selectedId.value}/merge`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    message.success("Merge OK");
    await work.loadJobs();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="faw-handoff h-full max-h-full min-h-0 overflow-hidden">
    <!-- Desktop: side-by-side -->
    <div class="hidden lg:grid grid-cols-12 gap-3 p-3 h-full min-h-0">
      <aside
        class="col-span-4 min-h-0 overflow-y-auto p-3 rounded-2xl panel-glass shadow-panel"
      >
        <h2
          class="text-sm font-semibold text-ink mb-3 sticky top-0 bg-surface-raised/90 py-1 backdrop-blur"
        >
          Done awaiting handoff
        </h2>
        <div
          v-for="j in handoffJobs"
          :key="j.id"
          class="rounded-xl border border-line p-3 mb-2 cursor-pointer hover:border-accent/50 bg-surface-raised/60 transition"
          :class="
            selectedId === j.id ? '!border-accent !bg-accent-soft shadow-sm' : ''
          "
          @click="selectJob(j.id)"
        >
          <div class="text-xs">
            <IssueIidLink
              :iid="j.issue?.issueIid"
              :url="j.issue?.url"
              link-class="!text-xs"
            />
          </div>
          <div class="text-sm text-ink-soft">{{ j.issue?.title }}</div>
          <div class="text-xs text-ink-faint mt-1 truncate">
            {{ j.summary || j.branch || j.id }}
          </div>
        </div>
        <a-empty
          v-if="!handoffJobs.length"
          description="No jobs awaiting handoff"
        />
      </aside>

      <section
        class="col-span-8 min-h-0 overflow-y-auto p-4 rounded-2xl panel-glass shadow-panel"
      >
        <template v-if="selected">
          <h2 class="text-lg font-semibold text-ink mt-0">
            <IssueIidLink
              :iid="selected.issue?.issueIid"
              :url="selected.issue?.url"
            />
            — {{ selected.issue?.title }}
          </h2>
          <p class="text-sm text-ink-muted whitespace-pre-wrap">
            {{ selected.summary || "—" }}
          </p>
          <a-form layout="vertical" class="max-w-lg mt-4">
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
            <div class="flex gap-2 flex-wrap">
              <a-button :loading="busy" @click="mergeBranch"
                >Merge → project</a-button
              >
              <a-button type="primary" :loading="busy" @click="confirmHandoff"
                >Confirm handoff</a-button
              >
            </div>
          </a-form>
        </template>
        <a-empty v-else description="Select a job on the left" />
      </section>
    </div>

    <!-- Mobile: list ↔ detail -->
    <div class="lg:hidden flex flex-col h-full min-h-0">
      <div
        v-show="!selectedId"
        class="flex-1 min-h-0 overflow-y-auto px-3 py-3"
      >
        <h2 class="text-sm font-semibold text-ink m-0 mb-3">
          Done awaiting handoff
          <span class="faw-count ml-1">{{ handoffJobs.length }}</span>
        </h2>
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
          <div class="text-[11px] text-ink-faint mt-1 truncate">
            {{ j.summary || j.branch || j.id }}
          </div>
        </button>
        <a-empty
          v-if="!handoffJobs.length"
          description="No jobs awaiting handoff"
        />
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
            <p class="text-sm text-ink-muted whitespace-pre-wrap m-0 mb-3">
              {{ selected.summary || "—" }}
            </p>
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
