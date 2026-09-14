<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { useBaChatStore } from "@/stores/baChat";
import {
  createDataApi,
  type CreateDataBatch,
  type CreateDataEnvironment,
  type CreateDataStepPlan,
} from "@/api/createDataApi";
import {
  subscribeRealtime,
  type RealtimeCreateDataProgress,
} from "@/realtime/client";

const ba = useBaChatStore();

const prompt = ref(
  "Create 2 users, each with 1 completed order and 1 pending order",
);
const environment = ref<CreateDataEnvironment>("staging");
const apiBaseUrl = ref("http://localhost:3000");
const authToken = ref("");

const planning = ref(false);
const saving = ref(false);
const executing = ref(false);
const rollingBack = ref(false);
const loadingHistory = ref(false);

const planSteps = ref<CreateDataStepPlan[]>([]);
const planQuestions = ref<string[]>([]);
const planNotes = ref<string[]>([]);
const planPlanner = ref<"ai" | "heuristic" | null>(null);
const editingPayloads = ref<Record<string, string>>({});
const progressLines = ref<RealtimeCreateDataProgress[]>([]);

const activeBatch = ref<CreateDataBatch | null>(null);
const history = ref<CreateDataBatch[]>([]);

const envOptions = [
  { value: "local", label: "Local" },
  { value: "development", label: "Development" },
  { value: "staging", label: "Staging" },
];

const seedConfig = computed(() => ba.selectedProject?.createData || null);

const seedHint = computed(() => {
  const cfg = seedConfig.value;
  if (!cfg?.configured) {
    return "Admin chưa cấu hình Create Data target cho project này — điền API base URL thủ công.";
  }
  if (!cfg.enabled) {
    return "Create Data target đang tắt (Admin) — vẫn có thể plan; bật enable để dùng URL mặc định.";
  }
  return cfg.notes || null;
});

const canGenerate = computed(
  () => Boolean(ba.selectedProjectId) && prompt.value.trim().length > 0,
);

const canSavePreview = computed(
  () =>
    Boolean(ba.selectedProjectId) &&
    planSteps.value.length > 0 &&
    apiBaseUrl.value.trim().length > 0,
);

const statusColor: Record<string, string> = {
  pending: "text-ink-muted",
  running: "text-blue-600",
  success: "text-green-700",
  failed: "text-red-600",
  skipped: "text-ink-faint",
  preview: "text-ink-muted",
  partial: "text-orange-600",
  rolled_back: "text-ink-muted",
};

function applySeedUrlForEnv() {
  const cfg = seedConfig.value;
  if (!cfg?.enabled) return;
  const hit = cfg.targets.find((t) => t.environment === environment.value);
  if (hit?.apiBaseUrl) apiBaseUrl.value = hit.apiBaseUrl;
}

function resultFor(stepId: string) {
  return activeBatch.value?.results.find((r) => r.step_id === stepId);
}

function syncPayloadEditors(steps: CreateDataStepPlan[]) {
  const next: Record<string, string> = {};
  for (const s of steps) {
    next[s.step_id] = s.payload
      ? JSON.stringify(s.payload, null, 2)
      : "";
  }
  editingPayloads.value = next;
}

function applyEditedPayloads(): CreateDataStepPlan[] | null {
  const out: CreateDataStepPlan[] = [];
  for (const s of planSteps.value) {
    const raw = editingPayloads.value[s.step_id] ?? "";
    if (!raw.trim()) {
      out.push({ ...s, payload: null });
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      out.push({ ...s, payload: parsed });
    } catch {
      message.error(`Invalid JSON payload on ${s.step_id}`);
      return null;
    }
  }
  return out;
}

async function generatePlan() {
  if (!canGenerate.value || !ba.selectedProjectId) return;
  planning.value = true;
  activeBatch.value = null;
  progressLines.value = [];
  try {
    const res = await createDataApi.plan({
      prompt: prompt.value.trim(),
      baProjectId: ba.selectedProjectId,
      environment: environment.value,
    });
    planSteps.value = res.plan.steps || [];
    planQuestions.value = res.plan.questions || [];
    planNotes.value = res.plan.notes || [];
    planPlanner.value = res.plan.planner || null;
    if (res.plan.suggestedApiBaseUrl) {
      apiBaseUrl.value = res.plan.suggestedApiBaseUrl;
    }
    syncPayloadEditors(planSteps.value);
    if (!planSteps.value.length) {
      message.warning("Planner needs more detail — see questions below");
    } else {
      const via = res.plan.planner === "ai" ? "AI + source" : "heuristic";
      message.success(`Plan ready · ${planSteps.value.length} steps (${via})`);
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    planning.value = false;
  }
}

async function stopPlan() {
  if (!ba.selectedProjectId) return;
  try {
    await createDataApi.stopPlan(ba.selectedProjectId);
    message.info("Stop requested");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function saveAndPreview() {
  if (!ba.selectedProjectId || !canSavePreview.value) return;
  const steps = applyEditedPayloads();
  if (!steps) return;
  saving.value = true;
  try {
    const res = await createDataApi.createBatch({
      baProjectId: ba.selectedProjectId,
      prompt: prompt.value.trim(),
      environment: environment.value,
      apiBaseUrl: apiBaseUrl.value.trim(),
      steps,
      questions: planQuestions.value,
    });
    activeBatch.value = res.batch;
    planSteps.value = res.batch.steps;
    syncPayloadEditors(planSteps.value);
    message.success(`Batch ${res.batch.batchId} saved — review then Execute`);
    await loadHistory();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function executeBatch() {
  if (!activeBatch.value) {
    message.warning("Save the plan as a batch first");
    return;
  }
  executing.value = true;
  try {
    const res = await createDataApi.execute(
      activeBatch.value.id,
      authToken.value.trim() || undefined,
    );
    activeBatch.value = res.batch;
    message[res.batch.status === "success" ? "success" : "warning"](
      `Batch ${res.batch.batchId}: ${res.batch.status}`,
    );
    await loadHistory();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    executing.value = false;
  }
}

function confirmRollback() {
  if (!activeBatch.value) return;
  Modal.confirm({
    title: "Rollback this batch?",
    content:
      "Deletes created records via rollback_endpoint (best effort). Production is never targeted.",
    okText: "Rollback",
    okType: "danger",
    async onOk() {
      rollingBack.value = true;
      try {
        const res = await createDataApi.rollback(
          activeBatch.value!.id,
          authToken.value.trim() || undefined,
        );
        activeBatch.value = res.batch;
        message.success("Rollback finished");
        await loadHistory();
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      } finally {
        rollingBack.value = false;
      }
    },
  });
}

async function loadHistory() {
  if (!ba.selectedProjectId) {
    history.value = [];
    return;
  }
  loadingHistory.value = true;
  try {
    const res = await createDataApi.listBatches(ba.selectedProjectId);
    history.value = res.batches || [];
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loadingHistory.value = false;
  }
}

async function openHistory(b: CreateDataBatch) {
  try {
    const res = await createDataApi.getBatch(b.id);
    activeBatch.value = res.batch;
    planSteps.value = res.batch.steps;
    prompt.value = res.batch.prompt;
    environment.value = res.batch.environment;
    apiBaseUrl.value = res.batch.apiBaseUrl;
    planQuestions.value = res.batch.questions || [];
    planPlanner.value = null;
    syncPayloadEditors(res.batch.steps);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

watch(
  () => ba.selectedProjectId,
  () => {
    void loadHistory();
    activeBatch.value = null;
    planSteps.value = [];
    progressLines.value = [];
    applySeedUrlForEnv();
  },
);

watch(environment, () => {
  applySeedUrlForEnv();
});

let unsubRt: (() => void) | undefined;

onMounted(() => {
  applySeedUrlForEnv();
  void loadHistory();
  unsubRt = subscribeRealtime({
    onCreateDataProgress: (ev) => {
      if (ev.baProjectId !== ba.selectedProjectId) return;
      // Server already scopes by userId; double-check project.
      progressLines.value = [...progressLines.value.slice(-24), ev];
    },
  });
});

onUnmounted(() => {
  unsubRt?.();
});
</script>

<template>
  <div class="faw-create-data h-full min-h-0 flex flex-col overflow-hidden">
    <div class="faw-console-head shrink-0">
      <div class="faw-console-head__title min-w-0">
        <h2>Create Data</h2>
        <div class="faw-console-head__win">
          AI Seed Planner (Cursor + code map) → preview → execute HTTP APIs — never Production / never direct DB insert
        </div>
      </div>
    </div>

    <div
      v-if="!ba.selectedProjectId"
      class="flex-1 flex items-center justify-center p-6 text-sm text-ink-muted"
    >
      Select a project to plan seed data.
    </div>

    <div
      v-else
      class="flex-1 min-h-0 overflow-hidden grid grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]"
    >
      <!-- Left: form + plan -->
      <div class="min-h-0 overflow-y-auto p-4 space-y-4 border-b lg:border-b-0 lg:border-r border-[var(--app-border)]">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Scenario</span>
          <a-textarea
            v-model:value="prompt"
            :rows="3"
            placeholder='e.g. "Create 10 users, each with 1 completed and 1 pending order"'
          />
        </label>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-ink-muted">Environment</span>
            <a-select
              v-model:value="environment"
              :options="envOptions"
              class="w-full"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-ink-muted">API base URL</span>
            <a-input
              v-model:value="apiBaseUrl"
              placeholder="http://localhost:3000"
            />
          </label>
        </div>

        <p v-if="seedHint" class="text-[12px] text-ink-muted m-0">
          {{ seedHint }}
        </p>

        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Auth token (optional, not stored on plan)</span>
          <a-input-password
            v-model:value="authToken"
            placeholder="Bearer token for target API"
            autocomplete="off"
          />
        </label>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="faw-btn faw-btn--run"
            :disabled="!canGenerate || planning"
            @click="generatePlan"
          >
            {{ planning ? "Planning…" : "Generate plan (AI)" }}
          </button>
          <button
            v-if="planning"
            type="button"
            class="faw-btn faw-btn--danger"
            @click="stopPlan"
          >
            Stop
          </button>
          <button
            type="button"
            class="faw-btn"
            :disabled="!canSavePreview || saving"
            @click="saveAndPreview"
          >
            {{ saving ? "Saving…" : "Save batch (preview)" }}
          </button>
          <button
            type="button"
            class="faw-btn faw-btn--run"
            :disabled="!activeBatch || executing || activeBatch?.status === 'running'"
            @click="executeBatch"
          >
            {{ executing ? "Executing…" : "Execute" }}
          </button>
          <button
            type="button"
            class="faw-btn"
            :disabled="
              !activeBatch ||
              rollingBack ||
              !['success', 'partial', 'failed'].includes(activeBatch.status)
            "
            @click="confirmRollback"
          >
            {{ rollingBack ? "Rolling back…" : "Rollback batch" }}
          </button>
        </div>

        <a-alert
          type="info"
          show-icon
          class="text-xs"
          message="Planner dùng Cursor SDK + code map / đọc source (và DB read-only nếu Admin đã Connect DB). Execute chỉ gọi HTTP API — Production bị chặn."
        />

        <div
          v-if="planning || progressLines.length"
          class="rounded border border-[var(--app-border)] p-2 space-y-1 max-h-40 overflow-y-auto"
        >
          <div class="text-[11px] font-medium text-ink-muted uppercase tracking-wide">
            Planner activity
          </div>
          <div
            v-for="(line, i) in progressLines"
            :key="`${line.step}-${i}-${line.label}`"
            class="text-[12px] font-mono text-ink truncate"
          >
            <span class="text-ink-faint">{{ line.step }}</span>
            · {{ line.label }}
            <span v-if="line.detail" class="text-ink-muted"> · {{ line.detail }}</span>
          </div>
          <div v-if="planning && !progressLines.length" class="text-[12px] text-ink-muted">
            Starting Cursor Seed Planner…
          </div>
        </div>

        <div v-if="planPlanner" class="text-[12px] text-ink-muted">
          Planner:
          <span class="text-ink">{{
            planPlanner === "ai" ? "AI (Cursor + source)" : "heuristic fallback"
          }}</span>
        </div>

        <div v-if="planNotes.length" class="text-[12px] text-ink-muted space-y-1">
          <div v-for="(n, i) in planNotes" :key="i">• {{ n }}</div>
        </div>

        <div v-if="planQuestions.length" class="space-y-1">
          <div class="text-sm font-medium text-orange-700">Needs clarification</div>
          <ul class="m-0 pl-4 text-[13px] text-ink-muted space-y-1">
            <li v-for="(q, i) in planQuestions" :key="i">{{ q }}</li>
          </ul>
        </div>

        <div v-if="activeBatch" class="text-[12px] text-ink-muted">
          Active batch
          <code class="text-ink">{{ activeBatch.batchId }}</code>
          ·
          <span :class="statusColor[activeBatch.status]">{{ activeBatch.status }}</span>
          <span v-if="activeBatch.error"> — {{ activeBatch.error }}</span>
        </div>

        <div v-if="planSteps.length" class="space-y-3">
          <div class="text-sm font-medium text-ink">Steps (edit payloads before save/execute)</div>
          <div
            v-for="(s, idx) in planSteps"
            :key="s.step_id"
            class="rounded border border-[var(--app-border)] p-3 space-y-2"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-[13px] font-medium text-ink">
                  {{ idx + 1 }}. {{ s.step_id }}
                  <span
                    v-if="resultFor(s.step_id)"
                    class="ml-2 text-[11px] font-normal"
                    :class="statusColor[resultFor(s.step_id)!.status]"
                  >
                    {{ resultFor(s.step_id)!.status }}
                  </span>
                </div>
                <div class="text-[12px] text-ink-muted">{{ s.description }}</div>
                <div class="text-[12px] font-mono mt-1">
                  {{ s.method }} {{ s.endpoint }}
                </div>
              </div>
            </div>
            <a-textarea
              v-model:value="editingPayloads[s.step_id]"
              :rows="4"
              class="font-mono text-[12px]"
              placeholder="null / JSON payload"
            />
            <div
              v-if="resultFor(s.step_id)?.error"
              class="text-[12px] text-red-600"
            >
              {{ resultFor(s.step_id)?.error }}
            </div>
            <div
              v-if="resultFor(s.step_id)?.createdId"
              class="text-[12px] text-green-700"
            >
              created id: {{ resultFor(s.step_id)?.createdId }}
            </div>
          </div>
        </div>
      </div>

      <!-- Right: history -->
      <div class="min-h-0 overflow-y-auto p-4 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="text-sm font-medium text-ink">Batch history</div>
          <button
            type="button"
            class="faw-btn text-xs"
            :disabled="loadingHistory"
            @click="loadHistory"
          >
            {{ loadingHistory ? "Loading…" : "Refresh" }}
          </button>
        </div>

        <div
          v-if="!history.length"
          class="text-[13px] text-ink-muted py-6"
        >
          No batches yet. Generate a plan, save preview, then execute.
        </div>

        <button
          v-for="b in history"
          :key="b.id"
          type="button"
          class="w-full text-left rounded border border-[var(--app-border)] px-3 py-2 hover:bg-[var(--app-panel,transparent)] transition-colors"
          :class="{
            'ring-1 ring-[var(--app-accent,#3b82f6)]': activeBatch?.id === b.id,
          }"
          @click="openHistory(b)"
        >
          <div class="flex items-center justify-between gap-2">
            <code class="text-[12px] text-ink">{{ b.batchId }}</code>
            <span class="text-[11px]" :class="statusColor[b.status]">{{
              b.status
            }}</span>
          </div>
          <div class="text-[12px] text-ink-muted mt-1 line-clamp-2">
            {{ b.prompt }}
          </div>
          <div class="text-[11px] text-ink-faint mt-1">
            {{ b.environment }} · {{ b.steps.length }} steps ·
            {{ new Date(b.createdAt).toLocaleString() }}
          </div>
        </button>
      </div>
    </div>
  </div>
</template>
