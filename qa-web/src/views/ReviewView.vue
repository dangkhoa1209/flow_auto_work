<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { qaApi, type QaJob } from "@/api/qaApi";
import { getAccessToken, getProjectId, getUsername } from "@/api/tokenStorage";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const route = useRoute();
const router = useRouter();
const job = ref<QaJob | null>(null);
const jobs = ref<QaJob[]>([]);
const progress = ref<Array<{ kind: string; text: string; at: string }>>([]);
const note = ref("");
const meta = ref<{
  members: Array<{ username: string }>;
  labels: Array<{ name: string }>;
  milestones: Array<{ id: number; title: string }>;
} | null>(null);
const approveForm = reactive({
  title: "",
  assignee: undefined as string | undefined,
  labels: [] as string[],
  milestoneId: undefined as number | undefined,
});
const busy = ref(false);
let es: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const jobId = computed(() => {
  const id = route.params.id;
  return typeof id === "string" && id ? id : null;
});

const canReview = computed(
  () =>
    job.value?.status === "awaiting_qa_review" ||
    job.value?.status === "needs_human_intervention",
);

async function loadList() {
  const res = await qaApi.listJobs();
  jobs.value = res.jobs;
  if (!jobId.value && res.jobs[0]) {
    router.replace(`/review/${res.jobs[0].id}`);
  }
}

async function loadJob(id: string) {
  const res = await qaApi.getJob(id);
  job.value = res.job;
  approveForm.title = res.job.qa?.draftTitle || "";
}

async function loadMeta() {
  try {
    meta.value = await qaApi.meta();
  } catch {
    meta.value = null;
  }
}

function connectSse() {
  es?.close();
  const token = getAccessToken();
  const project = getProjectId();
  const user = getUsername();
  const qs = new URLSearchParams();
  if (token) qs.set("access_token", token);
  if (project) qs.set("project", project);
  if (user) qs.set("user", user);
  es = new EventSource(`/api/events?${qs}`);
  es.addEventListener("progress", (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        jobId?: string;
        line?: { kind: string; text: string; at: string };
      };
      if (!jobId.value || data.jobId !== jobId.value || !data.line) return;
      progress.value = [...progress.value.slice(-200), data.line];
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("job", () => {
    if (jobId.value) void loadJob(jobId.value);
    void loadList();
  });
  es.addEventListener("screenshot", () => {
    if (jobId.value) void loadJob(jobId.value);
  });
}

async function adjust() {
  if (!jobId.value || !note.value.trim()) return;
  busy.value = true;
  try {
    await qaApi.adjust(jobId.value, note.value.trim());
    note.value = "";
    message.success("Đã gửi điều chỉnh — agent chạy tiếp");
    await loadJob(jobId.value);
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Adjust failed");
  } finally {
    busy.value = false;
  }
}

async function approve() {
  if (!jobId.value) return;
  busy.value = true;
  try {
    const res = await qaApi.approve(jobId.value, {
      title: approveForm.title || undefined,
      assignees: approveForm.assignee ? [approveForm.assignee] : undefined,
      labels: approveForm.labels,
      milestoneId: approveForm.milestoneId,
      description: job.value?.qa?.draftMarkdown,
    });
    message.success(`Đã tạo issue !${res.issue.iid}`);
    await loadJob(jobId.value);
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Approve failed");
  } finally {
    busy.value = false;
  }
}

async function kill() {
  if (!jobId.value) return;
  await qaApi.kill(jobId.value);
  message.info("Đã kill");
  await loadJob(jobId.value);
}

watch(
  jobId,
  async (id) => {
    progress.value = [];
    if (id) await loadJob(id);
  },
  { immediate: true },
);

onMounted(async () => {
  if (!session.ready) return;
  await Promise.all([loadList(), loadMeta()]);
  connectSse();
  pollTimer = setInterval(() => {
    if (jobId.value) void loadJob(jobId.value);
  }, 8000);
});

watch(
  () => session.ready,
  async (ok) => {
    if (!ok) return;
    await Promise.all([loadList(), loadMeta()]);
    connectSse();
  },
);

onUnmounted(() => {
  es?.close();
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="grid grid-cols-[240px_1fr] gap-4 h-[calc(100dvh-4.5rem)]">
    <aside class="rounded-lg border border-[#232833] bg-panel overflow-auto">
      <div
        v-for="j in jobs"
        :key="j.id"
        class="px-3 py-2 border-b border-[#232833] cursor-pointer text-xs"
        :class="j.id === jobId ? 'bg-[#171B24]' : 'hover:bg-[#171B24]'"
        @click="router.push(`/review/${j.id}`)"
      >
        <div class="text-white truncate">{{ j.qa?.testcase?.slice(0, 40) || j.id }}</div>
        <div class="text-muted">{{ j.status }}</div>
      </div>
    </aside>

    <div v-if="job" class="space-y-3 overflow-auto">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold text-white">{{ job.id }}</h2>
        <a-tag>{{ job.status }}</a-tag>
        <a-button size="small" danger :disabled="busy" @click="kill">Kill</a-button>
        <a
          v-if="job.qa?.createdIssueUrl"
          :href="job.qa.createdIssueUrl"
          target="_blank"
          class="text-accent text-sm ml-auto"
        >
          Mở GitLab Issue
        </a>
      </div>

      <div v-if="job.lastQuestion" class="text-amber-300 text-sm">
        Cần hỗ trợ: {{ job.lastQuestion }}
      </div>
      <div v-if="job.error" class="text-red-400 text-sm">{{ job.error }}</div>

      <section class="rounded-lg border border-[#232833] bg-panel p-3 space-y-2">
        <h3 class="text-white text-sm font-medium">Capture</h3>
        <div class="text-xs text-muted">URL: {{ job.qa?.targetUrl }}</div>
        <div v-if="job.qa?.actionLog?.length" class="font-mono text-xs space-y-1">
          <div v-for="(s, i) in job.qa.actionLog" :key="i">{{ s }}</div>
        </div>
        <div v-if="job.qa?.consoleErrors?.length" class="text-xs">
          <div class="text-red-300 font-medium">Console</div>
          <pre
            v-for="(e, i) in job.qa.consoleErrors"
            :key="i"
            class="whitespace-pre-wrap bg-[#0D0F14] p-2 rounded mt-1"
          >{{ e.message }}
{{ e.stack }}</pre>
        </div>
        <div v-if="job.qa?.networkFailures?.length" class="text-xs space-y-1">
          <div class="text-amber-300 font-medium">Network</div>
          <div v-for="(n, i) in job.qa.networkFailures" :key="i">
            {{ n.method }} {{ n.url }} → {{ n.status }}
          </div>
        </div>
        <div v-if="job.qa?.screenshotPaths?.length" class="flex gap-2 flex-wrap">
          <img
            v-for="p in job.qa.screenshotPaths"
            :key="p"
            :src="`/api/qa/artifacts/${job.id}/${p}`"
            class="max-h-48 rounded border border-[#232833]"
            alt="screenshot"
          />
        </div>
        <pre
          v-if="job.qa?.draftMarkdown"
          class="text-xs whitespace-pre-wrap bg-[#0D0F14] p-2 rounded max-h-64 overflow-auto"
        >{{ job.qa.draftMarkdown }}</pre>
      </section>

      <section class="rounded-lg border border-[#232833] bg-panel p-3">
        <h3 class="text-white text-sm font-medium mb-2">Live progress</h3>
        <div class="font-mono text-[11px] space-y-1 max-h-48 overflow-auto">
          <div v-for="(l, i) in progress" :key="i" class="text-muted">
            <span class="text-accent">[{{ l.kind }}]</span> {{ l.text }}
          </div>
        </div>
      </section>

      <section
        v-if="canReview"
        class="rounded-lg border border-[#232833] bg-panel p-3 space-y-3"
      >
        <h3 class="text-white text-sm font-medium">Human review</h3>
        <a-textarea
          v-model:value="note"
          :rows="3"
          placeholder="Ghi chú điều chỉnh nếu agent đi sai luồng…"
        />
        <a-button :loading="busy" @click="adjust">Điều chỉnh & chạy tiếp</a-button>

        <a-divider />

        <a-form layout="vertical">
          <a-form-item label="Issue title">
            <a-input v-model:value="approveForm.title" />
          </a-form-item>
          <div class="grid grid-cols-3 gap-2">
            <a-form-item label="Assignee">
              <a-select
                v-model:value="approveForm.assignee"
                allow-clear
                show-search
                class="w-full"
                :options="(meta?.members || []).map((m) => ({ value: m.username, label: m.username }))"
              />
            </a-form-item>
            <a-form-item label="Milestone">
              <a-select
                v-model:value="approveForm.milestoneId"
                allow-clear
                class="w-full"
                :options="(meta?.milestones || []).map((m) => ({ value: m.id, label: m.title }))"
              />
            </a-form-item>
            <a-form-item label="Labels">
              <a-select
                v-model:value="approveForm.labels"
                mode="multiple"
                class="w-full"
                :options="(meta?.labels || []).map((l) => ({ value: l.name, label: l.name }))"
              />
            </a-form-item>
          </div>
          <a-button type="primary" :loading="busy" @click="approve">
            Duyệt & Tạo Issue
          </a-button>
        </a-form>
      </section>
    </div>
    <div v-else class="text-muted p-4">Chọn một job để review</div>
  </div>
</template>
