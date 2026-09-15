<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
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

const prompt = ref("");
/** Fixed seed label — Production is blocked server-side. */
const environment: CreateDataEnvironment = "staging";

const planning = ref(false);
const saving = ref(false);
const executing = ref(false);
const rollingBack = ref(false);
const loadingHistory = ref(false);

const planSteps = ref<CreateDataStepPlan[]>([]);
const planQuestions = ref<string[]>([]);
const planNotes = ref<string[]>([]);
const planPlanner = ref<"ai" | "heuristic" | null>(null);
const editingData = ref<Record<string, string>>({});
const editingFilter = ref<Record<string, string>>({});
const progressLines = ref<RealtimeCreateDataProgress[]>([]);

const activeBatch = ref<CreateDataBatch | null>(null);
const history = ref<CreateDataBatch[]>([]);
const stepsSectionRef = ref<HTMLElement | null>(null);
const summarySectionRef = ref<HTMLElement | null>(null);
const planToastKey = ref("");
const showPlanNotes = ref(false);
const showPlannerLog = ref(false);
const forceShowEditors = ref(false);

const seedConfig = computed(() => ba.selectedProject?.createData || null);
const seedDbPublic = computed(() => seedConfig.value?.db || null);
const projectDbPublic = computed(() => ba.selectedProject?.db || null);

/** Prefer dedicated seed Connect; fall back to project Connect (Sync target). */
const effectiveDb = computed(() => {
  const seed = seedDbPublic.value;
  if (seed?.configured && seed.enabled) return seed;
  const proj = projectDbPublic.value;
  if (proj?.configured && proj.enabled) return proj;
  return seed || proj || null;
});

const dbTargetLabel = computed(() => {
  const d = effectiveDb.value;
  if (!d?.configured || !d.enabled) return null;
  return `${d.dialect || "?"} · ${d.database || "?"}`;
});

const seedHint = computed(() => {
  const cfg = seedConfig.value;
  const seed = seedDbPublic.value;
  const proj = projectDbPublic.value;
  if (
    !(seed?.configured && seed.enabled) &&
    !(proj?.configured && proj.enabled)
  ) {
    return "Admin has not configured Seed Connect DB (Create Data) — you can copy from the project Connect DB.";
  }
  if (!cfg?.enabled) {
    return "Create Data is off (Admin) — enable it on Admin Projects before execute.";
  }
  const d = effectiveDb.value;
  const via =
    seed?.configured && seed.enabled
      ? seed.ssh?.enabled
        ? "seed Connect (SSH tunnel)"
        : "seed Connect"
      : "project Connect (Sync target fallback)";
  const parts = [
    d ? `Target: ${d.dialect} ${d.database} · ${via}` : null,
    cfg.notes || null,
  ].filter(Boolean);
  return parts.join(" · ");
});

/** Create Data must be set up by Admin (feature toggle + seed DB) before QC can use it. */
const featureDisabledReason = computed(() => {
  if (!ba.selectedProjectId) return "";
  if (!seedConfig.value?.enabled) {
    return "Create Data is not set up for this project. Ask Admin to enable it on Admin → Projects.";
  }
  const db = effectiveDb.value;
  if (!db?.configured || !db.enabled) {
    return "Seed Connect DB is not configured or not active. Ask Admin to configure it on Admin → Projects.";
  }
  return "";
});

const canGenerate = computed(
  () =>
    Boolean(ba.selectedProjectId) &&
    !featureDisabledReason.value &&
    prompt.value.trim().length > 0,
);

const nextAction = computed(() => {
  if (planning.value) return null;
  if (brokenPlaceholders.value.length) {
    return {
      type: "warning" as const,
      text: `Plan has broken FK placeholders (${brokenPlaceholders.value
        .slice(0, 4)
        .join(", ")}${brokenPlaceholders.value.length > 4 ? "…" : ""}). Execute is blocked until you regenerate with real catalog ids from Connect DB.`,
    };
  }
  if (planSteps.value.length && !canSavePreview.value) {
    return {
      type: "warning" as const,
      text: `Plan is ready (${planSteps.value.length} steps), but Execute is blocked: ${saveDisabledReason.value}`,
    };
  }
  if (planSteps.value.length && !activeBatch.value) {
    return {
      type: "info" as const,
      text: `Plan ready · ${planSteps.value.length} steps. Review the JSON below, then click Execute to write to the seed Connect DB.`,
    };
  }
  if (activeBatch.value?.status === "preview") {
    return {
      type: "info" as const,
      text: `Batch ${activeBatch.value.batchId} ready (${planSteps.value.length} steps). Click Execute to write to the seed Connect DB.`,
    };
  }
  if (
    activeBatch.value &&
    ["success", "partial"].includes(activeBatch.value.status) &&
    brokenPlaceholders.value.length
  ) {
    return {
      type: "warning" as const,
      text: `Batch ${activeBatch.value.batchId} ran, but plan still has unresolved placeholders — catalog FKs were likely written empty. Rollback and regenerate the plan.`,
    };
  }
  return null;
});

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

function collectPlaceholderExprsLocal(value: unknown): string[] {
  const out: string[] = [];
  if (typeof value === "string") {
    for (const m of value.matchAll(PLACEHOLDER_RE)) {
      const expr = m[1]?.trim();
      if (expr) out.push(expr);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) out.push(...collectPlaceholderExprsLocal(v));
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      out.push(...collectPlaceholderExprsLocal(v));
    }
  }
  return out;
}

/** Placeholders that point at a step_id not present in the plan (e.g. {{fk_catalog.country_id}}). */
const brokenPlaceholders = computed(() => {
  const ids = new Set(planSteps.value.map((s) => s.step_id));
  const bad = new Set<string>();
  for (const s of planSteps.value) {
    for (const expr of [
      ...collectPlaceholderExprsLocal(s.data),
      ...collectPlaceholderExprsLocal(s.filter),
    ]) {
      if (!expr.includes(".")) {
        bad.add(`{{${expr}}}`);
        continue;
      }
      const ref = expr.split(".")[0]!;
      if (!ids.has(ref)) bad.add(`{{${expr}}}`);
    }
  }
  return [...bad];
});

const canSavePreview = computed(
  () =>
    Boolean(ba.selectedProjectId) &&
    planSteps.value.length > 0 &&
    Boolean(seedConfig.value?.enabled) &&
    Boolean(effectiveDb.value?.enabled) &&
    brokenPlaceholders.value.length === 0,
);

const saveDisabledReason = computed(() => {
  if (!planSteps.value.length) return "Generate a plan first";
  if (brokenPlaceholders.value.length) {
    return `Broken placeholders: ${brokenPlaceholders.value.slice(0, 3).join(", ")}`;
  }
  if (!seedConfig.value?.enabled) {
    return "Create Data is disabled for this project — ask Admin to enable it";
  }
  if (!effectiveDb.value?.enabled) {
    return "Seed Connect DB is not configured or not active";
  }
  return "";
});

const executeDisabledReason = computed(() => {
  if (!planSteps.value.length) return "Generate a plan first";
  if (brokenPlaceholders.value.length) {
    return "Plan has broken placeholders — regenerate before execute";
  }
  if (!canSavePreview.value) return saveDisabledReason.value;
  if (activeBatch.value?.status === "running") return "Batch is already running";
  return "";
});

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

function resultFor(stepId: string) {
  return activeBatch.value?.results.find((r) => r.step_id === stepId);
}

const IDENTITY_KEYS = [
  "staff_code",
  "staff_code_on_timekeeper",
  "code",
  "email",
  "full_name",
  "name",
  "username",
  "title",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickIdentity(data: Record<string, unknown> | null | undefined) {
  if (!data) return {} as Record<string, string>;
  const out: Record<string, string> = {};
  for (const key of IDENTITY_KEYS) {
    const raw = data[key];
    if (raw == null || raw === "") continue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw);
    }
  }
  return out;
}

type SummaryRow = {
  step_id: string;
  op: string;
  collection: string;
  status: string;
  createdId: string | null;
  labels: string[];
  error: string | null;
};

type CollectionCount = {
  collection: string;
  success: number;
  failed: number;
  skipped: number;
  total: number;
};

const executionSummary = computed(() => {
  const batch = activeBatch.value;
  if (!batch) return null;
  if (!["success", "partial", "failed", "rolled_back"].includes(batch.status)) {
    return null;
  }

  const byCollection = new Map<string, CollectionCount>();
  const rows: SummaryRow[] = [];
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const step of batch.steps) {
    const result = batch.results.find((r) => r.step_id === step.step_id);
    const status = result?.status || "pending";
    if (status === "success") success++;
    else if (status === "failed") failed++;
    else if (status === "skipped") skipped++;

    const key = step.collection || "(unknown)";
    const bucket = byCollection.get(key) || {
      collection: key,
      success: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    };
    bucket.total++;
    if (status === "success") bucket.success++;
    else if (status === "failed") bucket.failed++;
    else if (status === "skipped") bucket.skipped++;
    byCollection.set(key, bucket);

    const response = asRecord(result?.response);
    const document = asRecord(response?.document) || response;
    const identity = {
      ...pickIdentity(step.data),
      ...pickIdentity(document),
    };
    const labels = IDENTITY_KEYS.map((k) => identity[k])
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i) as string[];

    rows.push({
      step_id: step.step_id,
      op: step.op,
      collection: step.collection,
      status,
      createdId: result?.createdId || null,
      labels,
      error: result?.error || null,
    });
  }

  return {
    batchId: batch.batchId,
    status: batch.status,
    prompt: batch.prompt,
    total: batch.steps.length,
    success,
    failed,
    skipped,
    collections: [...byCollection.values()].sort((a, b) =>
      a.collection.localeCompare(b.collection),
    ),
    rows,
    error: batch.error || null,
  };
});

const showStepsEditors = computed(
  () =>
    forceShowEditors.value ||
    (planSteps.value.length > 0 &&
      (!activeBatch.value ||
        activeBatch.value.status === "preview" ||
        activeBatch.value.status === "running")),
);

function syncEditors(steps: CreateDataStepPlan[]) {
  const dataNext: Record<string, string> = {};
  const filterNext: Record<string, string> = {};
  for (const s of steps) {
    dataNext[s.step_id] = s.data ? JSON.stringify(s.data, null, 2) : "";
    filterNext[s.step_id] = s.filter ? JSON.stringify(s.filter, null, 2) : "";
  }
  editingData.value = dataNext;
  editingFilter.value = filterNext;
}

function applyPlan(plan: {
  steps?: CreateDataStepPlan[];
  questions?: string[];
  notes?: string[];
  planner?: "ai" | "heuristic" | null;
}) {
  planSteps.value = plan.steps || [];
  planQuestions.value = plan.questions || [];
  planNotes.value = plan.notes || [];
  planPlanner.value = plan.planner || null;
  syncEditors(planSteps.value);
  const key = `${planSteps.value.length}:${planQuestions.value.length}:${planPlanner.value}`;
  if (key !== planToastKey.value) {
    planToastKey.value = key;
    if (!planSteps.value.length) {
      message.warning("Planner needs more detail — see questions below");
    } else {
      const via = plan.planner === "heuristic" ? "heuristic" : "AI + source";
      message.success(`Plan ready · ${planSteps.value.length} steps (${via})`);
    }
  }
  void nextTick(() => {
    stepsSectionRef.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // Generate = plan + save: persist as a preview batch right away.
  if (planSteps.value.length) void autoSaveBatch();
}

function applyEditedSteps(): CreateDataStepPlan[] | null {
  const out: CreateDataStepPlan[] = [];
  for (const s of planSteps.value) {
    let data: Record<string, unknown> | null = null;
    let filter: Record<string, unknown> | null = null;
    const rawData = editingData.value[s.step_id] ?? "";
    const rawFilter = editingFilter.value[s.step_id] ?? "";
    if (rawData.trim()) {
      try {
        data = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        message.error(`Invalid JSON data on ${s.step_id}`);
        return null;
      }
    }
    if (rawFilter.trim()) {
      try {
        filter = JSON.parse(rawFilter) as Record<string, unknown>;
      } catch {
        message.error(`Invalid JSON filter on ${s.step_id}`);
        return null;
      }
    }
    out.push({ ...s, data, filter });
  }
  return out;
}

function resetNewForm() {
  if (planning.value) {
    message.warning("Stop the planner before starting a new form");
    return;
  }
  prompt.value = "";
  activeBatch.value = null;
  planSteps.value = [];
  planQuestions.value = [];
  planNotes.value = [];
  planPlanner.value = null;
  editingData.value = {};
  editingFilter.value = {};
  progressLines.value = [];
  planToastKey.value = "";
  showPlanNotes.value = false;
  showPlannerLog.value = false;
  forceShowEditors.value = false;
}

async function generatePlan() {
  if (!canGenerate.value || !ba.selectedProjectId) return;
  planning.value = true;
  activeBatch.value = null;
  progressLines.value = [];
  planToastKey.value = "";
  forceShowEditors.value = false;
  showPlannerLog.value = true;
  showPlanNotes.value = false;
  try {
    const res = await createDataApi.plan({
      prompt: prompt.value.trim(),
      baProjectId: ba.selectedProjectId,
      environment,
    });
    applyPlan(res.plan);
  } catch (e) {
    // SSE may have already delivered the plan after axios/proxy cut the HTTP wait.
    if (planSteps.value.length || planQuestions.value.length) return;
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

/** Auto-save the generated plan as a preview batch (Generate = plan + save). */
async function autoSaveBatch() {
  if (!ba.selectedProjectId || saving.value) return;
  if (activeBatch.value) return;
  if (!canSavePreview.value) return;
  const steps = applyEditedSteps();
  if (!steps?.length) return;
  saving.value = true;
  try {
    const res = await createDataApi.createBatch({
      baProjectId: ba.selectedProjectId,
      prompt: prompt.value.trim(),
      environment,
      steps,
      questions: planQuestions.value,
    });
    activeBatch.value = res.batch;
    planSteps.value = res.batch.steps;
    syncEditors(planSteps.value);
    await loadHistory();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

/**
 * Execute = (re)save if steps were edited or nothing saved yet, then run.
 * Keeps the UI flow at two buttons: Generate → Execute.
 */
async function executeBatch() {
  if (!ba.selectedProjectId || !canSavePreview.value) return;
  const steps = applyEditedSteps();
  if (!steps?.length) return;
  executing.value = true;
  try {
    let batch = activeBatch.value;
    const editsDiffer =
      !batch ||
      batch.status !== "preview" ||
      JSON.stringify(steps) !== JSON.stringify(batch.steps);
    if (editsDiffer) {
      const saved = await createDataApi.createBatch({
        baProjectId: ba.selectedProjectId,
        prompt: prompt.value.trim(),
        environment,
        steps,
        questions: planQuestions.value,
      });
      batch = saved.batch;
      activeBatch.value = batch;
    }
    const res = await createDataApi.execute(batch!.id);
    activeBatch.value = res.batch;
    const ok =
      res.batch.results?.filter((r) => r.status === "success").length || 0;
    const fail =
      res.batch.results?.filter((r) => r.status === "failed").length || 0;
    message.success(
      fail
        ? `Batch ${res.batch.status} · ${ok} ok · ${fail} failed`
        : `Batch ${res.batch.status} · ${ok} records written`,
    );
    await loadHistory();
    void nextTick(() => {
      summarySectionRef.value?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    executing.value = false;
  }
}

function confirmRollback() {
  if (!activeBatch.value) return;
  Modal.confirm({
    title: "Rollback batch?",
    content:
      "Deletes inserted rows/docs by recorded createdId (insert steps only).",
    okText: "Rollback",
    okType: "danger",
    async onOk() {
      rollingBack.value = true;
      try {
        const res = await createDataApi.rollback(activeBatch.value!.id);
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
  if (!ba.selectedProjectId) return;
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
    planQuestions.value = res.batch.questions || [];
    prompt.value = res.batch.prompt;
    forceShowEditors.value = false;
    showPlanNotes.value = false;
    syncEditors(planSteps.value);
    void nextTick(() => {
      if (
        ["success", "partial", "failed", "rolled_back"].includes(
          res.batch.status,
        )
      ) {
        summarySectionRef.value?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    });
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

watch(
  () => ba.selectedProjectId,
  () => {
    activeBatch.value = null;
    planSteps.value = [];
    planNotes.value = [];
    planQuestions.value = [];
    progressLines.value = [];
    planToastKey.value = "";
    forceShowEditors.value = false;
    showPlannerLog.value = false;
    showPlanNotes.value = false;
    void loadHistory();
  },
);

let unsubRt: (() => void) | undefined;

onMounted(() => {
  void loadHistory();
  unsubRt = subscribeRealtime({
    onCreateDataProgress: (ev) => {
      if (ev.baProjectId !== ba.selectedProjectId) return;
      progressLines.value = [...progressLines.value.slice(-24), ev];
      if (ev.plan && (ev.step === "done" || ev.step === "error")) {
        applyPlan(ev.plan);
        planning.value = false;
      }
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
          AI Seed Planner → preview → insert/update Connect DB — never Production
        </div>
      </div>
      <button
        v-if="ba.selectedProjectId"
        type="button"
        class="faw-btn faw-btn--run faw-btn--tight text-xs shrink-0 self-center !flex-none !px-2 !py-0.5"
        :disabled="planning || executing || saving || rollingBack"
        @click="resetNewForm"
      >
        New
      </button>
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
      <div class="min-h-0 overflow-y-auto p-4 space-y-4 border-b lg:border-b-0 lg:border-r border-[var(--app-border)]">
        <a-alert
          v-if="featureDisabledReason"
          type="warning"
          show-icon
          :message="featureDisabledReason"
        />

        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Scenario</span>
          <a-textarea
            v-model:value="prompt"
            :rows="3"
            :disabled="Boolean(featureDisabledReason)"
            placeholder='e.g. "Create a new employee named An" (AI fills remaining fields) or "Create employee with CCCD 33333" (invalid rule → error)'
          />
        </label>

        <div class="flex flex-col gap-1 text-sm max-w-md">
          <span class="text-ink-muted">Seed Connect DB target</span>
          <div
            class="min-h-[32px] px-3 py-1.5 rounded border border-[var(--app-border)] text-[13px] font-mono"
            :class="dbTargetLabel ? 'text-ink' : 'text-ink-muted'"
          >
            {{ dbTargetLabel || "Not configured" }}
          </div>
        </div>

        <p
          v-if="seedHint && !featureDisabledReason && !dbTargetLabel"
          class="text-[12px] text-ink-muted m-0"
        >
          {{ seedHint }}
        </p>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="faw-btn"
            :class="{ 'faw-btn--run': !planSteps.length || planning }"
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
          <a-tooltip :title="executeDisabledReason || undefined">
            <span>
              <button
                type="button"
                class="faw-btn"
                :class="{
                  'faw-btn--run': canSavePreview && !executing,
                }"
                :disabled="
                  !canSavePreview ||
                  executing ||
                  saving ||
                  planning ||
                  activeBatch?.status === 'running'
                "
                @click="executeBatch"
              >
                {{ executing ? "Executing…" : saving ? "Saving…" : "Execute" }}
              </button>
            </span>
          </a-tooltip>
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
          v-if="nextAction"
          :type="nextAction.type"
          show-icon
          class="text-xs"
          :message="nextAction.text"
        />

        <div
          v-if="planning || (progressLines.length && showPlannerLog)"
          class="rounded border border-[var(--app-border)] p-2 space-y-1 max-h-40 overflow-y-auto"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="text-[11px] font-medium text-ink-muted uppercase tracking-wide">
              Planner activity
            </div>
            <button
              v-if="!planning && progressLines.length"
              type="button"
              class="text-[11px] text-ink-muted underline"
              @click="showPlannerLog = false"
            >
              Hide
            </button>
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
        <button
          v-else-if="progressLines.length && !planning"
          type="button"
          class="text-[11px] text-ink-muted underline"
          @click="showPlannerLog = true"
        >
          Show planner log ({{ progressLines.length }})
        </button>

        <div v-if="planQuestions.length" class="space-y-1">
          <div class="text-sm font-medium text-orange-700">
            Needs clarification / validation
          </div>
          <ul class="m-0 pl-4 text-[13px] text-ink-muted space-y-1">
            <li v-for="(q, i) in planQuestions" :key="i">{{ q }}</li>
          </ul>
        </div>

        <div v-if="planNotes.length">
          <button
            type="button"
            class="text-[12px] text-ink-muted underline"
            @click="showPlanNotes = !showPlanNotes"
          >
            {{ showPlanNotes ? "Hide" : "Show" }} planner notes ({{ planNotes.length }})
          </button>
          <div
            v-if="showPlanNotes"
            class="mt-1 text-[12px] text-ink-muted space-y-1"
          >
            <div v-for="(n, i) in planNotes" :key="i">• {{ n }}</div>
          </div>
        </div>

        <div
          v-if="executionSummary"
          ref="summarySectionRef"
          class="rounded border border-[var(--app-border)] p-3 space-y-3 bg-[var(--app-panel,transparent)]"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <div class="text-sm font-medium text-ink">Execution summary</div>
            <div class="text-[12px] text-ink-muted">
              <code class="text-ink">{{ executionSummary.batchId }}</code>
              ·
              <span :class="statusColor[executionSummary.status]">{{
                executionSummary.status
              }}</span>
            </div>
          </div>

          <div class="flex flex-wrap gap-3 text-[13px]">
            <span class="text-green-700 font-medium"
              >{{ executionSummary.success }} success</span
            >
            <span v-if="executionSummary.failed" class="text-red-600 font-medium"
              >{{ executionSummary.failed }} failed</span
            >
            <span v-if="executionSummary.skipped" class="text-ink-muted"
              >{{ executionSummary.skipped }} skipped</span
            >
            <span class="text-ink-muted"
              >{{ executionSummary.total }} steps total</span
            >
          </div>

          <div
            v-if="executionSummary.collections.length"
            class="flex flex-wrap gap-2"
          >
            <span
              v-for="c in executionSummary.collections"
              :key="c.collection"
              class="inline-flex items-center gap-1 rounded border border-[var(--app-border)] px-2 py-0.5 text-[12px] font-mono"
            >
              {{ c.collection }}
              <span class="text-green-700">{{ c.success }}</span>
              <span v-if="c.failed" class="text-red-600">/ {{ c.failed }} fail</span>
            </span>
          </div>

          <p
            v-if="executionSummary.error"
            class="m-0 text-[12px] text-red-600"
          >
            {{ executionSummary.error }}
          </p>

          <div class="overflow-x-auto">
            <table class="w-full text-left text-[12px] border-collapse">
              <thead>
                <tr class="text-ink-muted border-b border-[var(--app-border)]">
                  <th class="py-1 pr-2 font-medium">#</th>
                  <th class="py-1 pr-2 font-medium">Collection</th>
                  <th class="py-1 pr-2 font-medium">Code / name</th>
                  <th class="py-1 pr-2 font-medium">Id</th>
                  <th class="py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, idx) in executionSummary.rows"
                  :key="row.step_id"
                  class="border-b border-[var(--app-border)] align-top"
                >
                  <td class="py-1.5 pr-2 text-ink-faint">{{ idx + 1 }}</td>
                  <td class="py-1.5 pr-2 font-mono">
                    {{ row.op }} {{ row.collection }}
                  </td>
                  <td class="py-1.5 pr-2">
                    <div v-if="row.labels.length" class="space-y-0.5">
                      <div
                        v-for="(lab, li) in row.labels"
                        :key="li"
                        class="font-mono text-ink"
                      >
                        {{ lab }}
                      </div>
                    </div>
                    <span v-else class="text-ink-faint">{{ row.step_id }}</span>
                  </td>
                  <td class="py-1.5 pr-2 font-mono text-ink-muted break-all">
                    {{ row.createdId || "—" }}
                  </td>
                  <td class="py-1.5">
                    <span :class="statusColor[row.status]">{{ row.status }}</span>
                    <div
                      v-if="row.error"
                      class="text-red-600 mt-0.5 max-w-[220px]"
                    >
                      {{ row.error }}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div
          v-else-if="activeBatch"
          class="text-[12px] text-ink-muted"
        >
          Active batch
          <code class="text-ink">{{ activeBatch.batchId }}</code>
          ·
          <span :class="statusColor[activeBatch.status]">{{
            activeBatch.status
          }}</span>
        </div>

        <div
          ref="stepsSectionRef"
          v-if="showStepsEditors"
          class="space-y-3"
        >
          <div class="text-sm font-medium text-ink">
            Steps (edit data/filter before Execute)
          </div>
          <div
            v-for="(s, idx) in planSteps"
            :key="s.step_id"
            class="rounded border border-[var(--app-border)] p-3 space-y-2"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-[13px] font-medium text-ink">
                  {{ idx + 1 }}. {{ s.step_id }}
                </div>
                <div class="text-[12px] text-ink-muted">{{ s.description }}</div>
                <div class="text-[12px] font-mono mt-1">
                  {{ s.op }} {{ s.collection }}
                </div>
              </div>
            </div>
            <label class="flex flex-col gap-1 text-[11px] text-ink-muted">
              data
              <a-textarea
                v-model:value="editingData[s.step_id]"
                :rows="4"
                class="font-mono text-[12px]"
                placeholder="null / JSON document or row"
              />
            </label>
            <label
              v-if="s.op !== 'insert'"
              class="flex flex-col gap-1 text-[11px] text-ink-muted"
            >
              filter
              <a-textarea
                v-model:value="editingFilter[s.step_id]"
                :rows="2"
                class="font-mono text-[12px]"
                placeholder="WHERE / Mongo filter JSON"
              />
            </label>
          </div>
        </div>

        <button
          v-else-if="planSteps.length && executionSummary"
          type="button"
          class="text-[12px] text-ink-muted underline"
          @click="forceShowEditors = true"
        >
          Show step JSON ({{ planSteps.length }})
        </button>
      </div>

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
          No batches yet. Generate a plan, then Execute.
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
            {{ b.steps.length }} steps ·
            {{ new Date(b.createdAt).toLocaleString() }}
          </div>
        </button>
      </div>
    </div>
  </div>
</template>
