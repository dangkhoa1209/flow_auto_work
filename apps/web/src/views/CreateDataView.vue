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
import { ApiError } from "@/api/client";
import {
  subscribeRealtime,
  type RealtimeCreateDataProgress,
} from "@/realtime/client";
import {
  safeGetItem,
  safeRemoveItem,
  safeSetItem,
} from "@/utils/safeStorage";

const ba = useBaChatStore();

const DRAFT_KEY = "faw.createData.draft.v1";
/** Keep waiting for SSE after gateway/proxy cuts the HTTP /plan response. */
const waitingForSse = ref(false);

type CreateDataDraft = {
  baProjectId: string;
  prompt: string;
  followUp: string;
  planning: boolean;
  waitingForSse: boolean;
  planningMode: "generate" | "refine";
  planStageIndex: number;
  planToastKey: string;
  planSteps: CreateDataStepPlan[];
  planQuestions: string[];
  planNotes: string[];
  planPlanner: "ai" | "heuristic" | null;
  progressLines: RealtimeCreateDataProgress[];
  savedAt: number;
};

function normalizePlanQuestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push(t);
      continue;
    }
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const field = String(row.field || "").trim();
      const reason = String(row.reason || row.message || "").trim();
      const line = field && reason ? `${field}: ${reason}` : reason || field;
      if (line) out.push(line);
    }
  }
  return out;
}

function isPlanHttpTimeout(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 504 || err.status === 502 || err.status === 408;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /504|502|408|timeout|timed out|gateway/i.test(msg);
}

function persistCreateDataDraft() {
  const projectId = ba.selectedProjectId;
  if (!projectId) return;
  const draft: CreateDataDraft = {
    baProjectId: projectId,
    prompt: prompt.value,
    followUp: followUp.value,
    planning: planning.value,
    waitingForSse: waitingForSse.value,
    planningMode: planningMode.value,
    planStageIndex: planStageIndex.value,
    planToastKey: planToastKey.value,
    planSteps: planSteps.value,
    planQuestions: planQuestions.value,
    planNotes: planNotes.value,
    planPlanner: planPlanner.value,
    progressLines: progressLines.value.slice(-24),
    savedAt: Date.now(),
  };
  safeSetItem(DRAFT_KEY, JSON.stringify(draft));
}

function clearCreateDataDraft() {
  safeRemoveItem(DRAFT_KEY);
}

function restoreCreateDataDraft(): boolean {
  const raw = safeGetItem(DRAFT_KEY);
  if (!raw) return false;
  try {
    const draft = JSON.parse(raw) as CreateDataDraft;
    if (!draft?.baProjectId) return false;
    // Stale after 30 minutes
    if (Date.now() - (draft.savedAt || 0) > 30 * 60 * 1000) {
      clearCreateDataDraft();
      return false;
    }
    if (
      ba.selectedProjectId &&
      draft.baProjectId !== ba.selectedProjectId
    ) {
      return false;
    }
    prompt.value = draft.prompt || "";
    followUp.value = draft.followUp || "";
    planningMode.value = draft.planningMode || "generate";
    planStageIndex.value = draft.planStageIndex || 0;
    planToastKey.value = draft.planToastKey || "";
    planSteps.value = Array.isArray(draft.planSteps) ? draft.planSteps : [];
    planQuestions.value = normalizePlanQuestions(draft.planQuestions);
    planNotes.value = Array.isArray(draft.planNotes) ? draft.planNotes : [];
    planPlanner.value = draft.planPlanner || null;
    progressLines.value = Array.isArray(draft.progressLines)
      ? draft.progressLines
      : [];
    syncEditors(planSteps.value);
    if (draft.planning || draft.waitingForSse) {
      planning.value = true;
      waitingForSse.value = true;
    }
    return true;
  } catch {
    clearCreateDataDraft();
    return false;
  }
}

const prompt = ref("");
/** Fixed seed label — Production is blocked server-side. */
const environment: CreateDataEnvironment = "staging";

const planning = ref(false);
const saving = ref(false);
const executing = ref(false);
const rollingBack = ref(false);
const loadingHistory = ref(false);

const planSteps = ref<CreateDataStepPlan[]>([]);
const followUp = ref("");
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
/** Expand raw JSON editors for steps (cards are the default view). */
const forceShowEditors = ref(false);
/** Per-step expand of raw JSON when not using global forceShowEditors. */
const expandedStepJson = ref<Record<string, boolean>>({});
/** Planning mode: fresh generate vs refine (affects progress copy). */
const planningMode = ref<"generate" | "refine">("generate");

/** 6 fixed milestones for Generate progress %. */
const PLAN_STAGES = [
  { id: "source", label: "Reading project source code…", pct: 12 },
  { id: "gitlab", label: "Loading GitLab issue…", pct: 28 },
  { id: "prefetch", label: "Checking existing data in the database…", pct: 45 },
  { id: "lookup", label: "Looking up related data…", pct: 62 },
  { id: "draft", label: "Drafting the plan…", pct: 82 },
  { id: "done", label: "Plan ready", pct: 100 },
] as const;

const planStageIndex = ref(0);

function extractGitlabIid(label: string): string | null {
  const m = label.match(/#(\d+)/);
  return m?.[1] || null;
}

function mapProgressToStage(ev: RealtimeCreateDataProgress): {
  index: number;
  label: string;
} {
  const raw = `${ev.label || ""} ${ev.detail || ""}`.toLowerCase();
  const step = ev.step;

  if (step === "done" || step === "error") {
    return {
      index: 5,
      label:
        step === "error"
          ? "Planner finished with issues — see details below"
          : "Plan ready",
    };
  }
  if (
    /gitlab|issue\s*#|#\d+/.test(raw) ||
    /reading gitlab/i.test(ev.label || "")
  ) {
    const iid = extractGitlabIid(ev.label || "") || extractGitlabIid(ev.detail || "");
    return {
      index: 1,
      label: iid
        ? `Loading GitLab issue #${iid}…`
        : "Loading GitLab issue…",
    };
  }
  if (
    /prefetch|listcollections|collections|checking existing/i.test(raw) ||
    /prefetching/i.test(ev.label || "")
  ) {
    return { index: 2, label: PLAN_STAGES[2].label };
  }
  if (
    step === "tool" ||
    /query_readonly|query_\*|code_map/i.test(raw)
  ) {
    return { index: 3, label: PLAN_STAGES[3].label };
  }
  if (step === "write" || /draft|soạn|writing plan/i.test(raw)) {
    return { index: 4, label: PLAN_STAGES[4].label };
  }
  if (
    step === "pull" ||
    step === "start" ||
    /sync|graphify|code map|source/i.test(raw)
  ) {
    return { index: 0, label: PLAN_STAGES[0].label };
  }
  // Default: stay on current stage label or lookup
  const cur = planStageIndex.value;
  return {
    index: Math.max(cur, 3),
    label: PLAN_STAGES[Math.min(Math.max(cur, 3), 4)].label,
  };
}

const humanProgress = computed(() => {
  if (!planning.value && planStageIndex.value < 5) return null;
  if (!planning.value && !progressLines.value.length) return null;
  const idx = Math.min(planStageIndex.value, PLAN_STAGES.length - 1);
  const stage = PLAN_STAGES[idx];
  const last = progressLines.value[progressLines.value.length - 1];
  const mapped = last ? mapProgressToStage(last) : null;
  return {
    label:
      planning.value && mapped
        ? mapped.label
        : planning.value
          ? stage.label
          : "Plan ready",
    pct: planning.value ? stage.pct : 100,
    stageIndex: idx,
    totalStages: PLAN_STAGES.length,
  };
});

function ingestProgress(ev: RealtimeCreateDataProgress) {
  progressLines.value = [...progressLines.value.slice(-24), ev];
  const mapped = mapProgressToStage(ev);
  // Never go backwards except reset on new run.
  if (mapped.index >= planStageIndex.value) {
    planStageIndex.value = mapped.index;
  }
  if (planning.value || waitingForSse.value) {
    persistCreateDataDraft();
  }
}

const hasPlanSession = computed(
  () => planSteps.value.length > 0 || planQuestions.value.length > 0,
);

function opCounts(steps: CreateDataStepPlan[]) {
  let insert = 0;
  let update = 0;
  let del = 0;
  for (const s of steps) {
    if (s.op === "insert") insert++;
    else if (s.op === "update") update++;
    else if (s.op === "delete") del++;
  }
  return { insert, update, delete: del };
}

function batchPreviewLine(b: CreateDataBatch): string {
  const counts = opCounts(b.steps);
  const parts: string[] = [];
  if (counts.insert) parts.push(`${counts.insert} insert`);
  if (counts.update) parts.push(`${counts.update} update`);
  if (counts.delete) parts.push(`${counts.delete} delete`);
  const ops = parts.length ? parts.join(", ") : "0 steps";
  const collections = [
    ...new Set(b.steps.map((s) => s.collection).filter(Boolean)),
  ].slice(0, 4);
  const more =
    new Set(b.steps.map((s) => s.collection).filter(Boolean)).size >
    collections.length
      ? "…"
      : "";
  return collections.length
    ? `${ops} · ${collections.join(", ")}${more}`
    : ops;
}

const executePreviewText = computed(() => {
  const counts = opCounts(planSteps.value);
  const target = dbTargetLabel.value || "seed Connect DB";
  return `About to run: ${counts.insert} insert, ${counts.update} update, ${counts.delete} delete on ${target}`;
});

function formatFieldValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stepFieldEntries(
  data: Record<string, unknown> | null | undefined,
): Array<{ key: string; value: string }> {
  if (!data) return [];
  return Object.entries(data).map(([key, value]) => ({
    key,
    value: formatFieldValue(value),
  }));
}

function stepDataForDisplay(step: CreateDataStepPlan): Record<string, unknown> | null {
  const raw = editingData.value[step.step_id];
  if (raw?.trim()) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return step.data;
}

function stepFilterForDisplay(
  step: CreateDataStepPlan,
): Record<string, unknown> | null {
  const raw = editingFilter.value[step.step_id];
  if (raw?.trim()) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return step.filter;
}

function stepIdentityLabels(step: CreateDataStepPlan): string[] {
  const fromData = pickIdentity(stepDataForDisplay(step));
  const fromFilter = pickIdentity(stepFilterForDisplay(step));
  const merged = { ...fromFilter, ...fromData };
  return IDENTITY_KEYS.map((k) =>
    merged[k] ? `${k}=${merged[k]}` : "",
  ).filter(Boolean);
}

function toggleStepJson(stepId: string) {
  expandedStepJson.value = {
    ...expandedStepJson.value,
    [stepId]: !expandedStepJson.value[stepId],
  };
}

function isStepJsonOpen(stepId: string) {
  return forceShowEditors.value || Boolean(expandedStepJson.value[stepId]);
}

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

const showStepsCards = computed(() => planSteps.value.length > 0);

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
  planQuestions.value = normalizePlanQuestions(plan.questions);
  planNotes.value = plan.notes || [];
  planPlanner.value = plan.planner || null;
  syncEditors(planSteps.value);
  planStageIndex.value = 5;
  waitingForSse.value = false;
  const key = `${planSteps.value.length}:${planQuestions.value.length}:${planPlanner.value}`;
  if (key !== planToastKey.value) {
    planToastKey.value = key;
    if (!planSteps.value.length) {
      message.warning(
        planQuestions.value.length
          ? "Planner needs clarification — see Conversation below"
          : "Planner returned no steps",
      );
    } else {
      const via = plan.planner === "heuristic" ? "heuristic" : "AI + source";
      message.success(`Plan ready · ${planSteps.value.length} steps (${via})`);
    }
  }
  persistCreateDataDraft();
  void nextTick(() => {
    const el = planQuestions.value.length
      ? document.querySelector(".faw-create-data-conversation")
      : stepsSectionRef.value;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  followUp.value = "";
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
  expandedStepJson.value = {};
  planStageIndex.value = 0;
  planningMode.value = "generate";
  waitingForSse.value = false;
  clearCreateDataDraft();
}

async function generatePlan() {
  if (!canGenerate.value || !ba.selectedProjectId) return;
  planning.value = true;
  waitingForSse.value = false;
  planningMode.value = "generate";
  activeBatch.value = null;
  progressLines.value = [];
  planStageIndex.value = 0;
  planToastKey.value = "";
  forceShowEditors.value = false;
  expandedStepJson.value = {};
  showPlannerLog.value = false;
  showPlanNotes.value = false;
  persistCreateDataDraft();
  try {
    const res = await createDataApi.plan({
      prompt: prompt.value.trim(),
      baProjectId: ba.selectedProjectId,
      environment,
    });
    applyPlan(res.plan);
  } catch (e) {
    // SSE may have already delivered the plan after axios/proxy cut the HTTP wait.
    if (planToastKey.value || planSteps.value.length || planQuestions.value.length) {
      return;
    }
    if (isPlanHttpTimeout(e)) {
      // Agent often still finishes server-side; keep UI in planning and wait for SSE.
      waitingForSse.value = true;
      planning.value = true;
      persistCreateDataDraft();
      return;
    }
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    if (!waitingForSse.value) {
      planning.value = false;
      persistCreateDataDraft();
    }
  }
}

const canRefine = computed(
  () =>
    Boolean(ba.selectedProjectId) &&
    !planning.value &&
    !executing.value &&
    !saving.value &&
    !featureDisabledReason.value &&
    (planSteps.value.length > 0 || planQuestions.value.length > 0) &&
    followUp.value.trim().length > 0,
);

/**
 * Continuous interaction: send a follow-up on top of the current plan (e.g.
 * answering validation questions) — planner updates the plan instead of
 * starting over.
 */
async function refinePlan() {
  if (!canRefine.value || !ba.selectedProjectId) return;
  const previousPlan = {
    steps: planSteps.value,
    questions: planQuestions.value,
    notes: planNotes.value,
  };
  planning.value = true;
  waitingForSse.value = false;
  planningMode.value = "refine";
  activeBatch.value = null;
  progressLines.value = [];
  planStageIndex.value = 0;
  planToastKey.value = "";
  forceShowEditors.value = false;
  expandedStepJson.value = {};
  showPlannerLog.value = false;
  persistCreateDataDraft();
  try {
    const res = await createDataApi.plan({
      prompt: prompt.value.trim(),
      baProjectId: ba.selectedProjectId,
      environment,
      followUp: followUp.value.trim(),
      previousPlan,
    });
    applyPlan(res.plan);
    followUp.value = "";
  } catch (e) {
    if (
      planToastKey.value ||
      planSteps.value.length ||
      planQuestions.value.length
    ) {
      followUp.value = "";
      return;
    }
    if (isPlanHttpTimeout(e)) {
      waitingForSse.value = true;
      planning.value = true;
      persistCreateDataDraft();
      return;
    }
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    if (!waitingForSse.value) {
      planning.value = false;
      persistCreateDataDraft();
    }
  }
}

async function stopPlan() {
  if (!ba.selectedProjectId) return;
  try {
    await createDataApi.stopPlan(ba.selectedProjectId);
    waitingForSse.value = false;
    planning.value = false;
    persistCreateDataDraft();
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
 * Execute = confirm → (re)save if steps were edited → run.
 */
function confirmExecute() {
  if (!ba.selectedProjectId || !canSavePreview.value) return;
  const steps = applyEditedSteps();
  if (!steps?.length) return;
  Modal.confirm({
    title: "Write to seed Connect DB?",
    content: executePreviewText.value,
    okText: "Execute",
    cancelText: "Cancel",
    onOk: () => executeBatch(),
  });
}

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
    expandedStepJson.value = {};
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
    expandedStepJson.value = {};
    planStageIndex.value = 0;
    waitingForSse.value = false;
    planning.value = false;
    followUp.value = "";
    void loadHistory();
    restoreCreateDataDraft();
  },
);

let unsubRt: (() => void) | undefined;

onMounted(() => {
  restoreCreateDataDraft();
  void loadHistory();
  unsubRt = subscribeRealtime({
    onCreateDataProgress: (ev) => {
      if (ev.baProjectId !== ba.selectedProjectId) return;
      // Resume waiting UI if we reconnected mid-plan.
      if (waitingForSse.value) planning.value = true;
      ingestProgress(ev);
      if (ev.plan && (ev.step === "done" || ev.step === "error")) {
        planStageIndex.value = 5;
        applyPlan(ev.plan);
        planning.value = false;
        waitingForSse.value = false;
        persistCreateDataDraft();
      }
    },
  });
});

onUnmounted(() => {
  if (planning.value || waitingForSse.value || hasPlanSession.value) {
    persistCreateDataDraft();
  }
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
          class="faw-create-data-alert faw-create-data-alert--warning"
          :message="featureDisabledReason"
        />

        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Scenario</span>
          <a-textarea
            v-model:value="prompt"
            :rows="3"
            :disabled="Boolean(featureDisabledReason)"
            placeholder='e.g. "Create a new employee named An", paste a GitLab issue link / #123, or "Create employee with CCCD 33333" (invalid rule → error)'
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
          class="text-[13px] text-ink-muted m-0"
        >
          {{ seedHint }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <template v-if="!hasPlanSession">
            <button
              type="button"
              class="faw-btn faw-btn--run"
              :disabled="!canGenerate || planning"
              @click="generatePlan"
            >
              {{ planning ? "Planning…" : "Generate new plan" }}
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="faw-btn text-xs !flex-none"
              :disabled="!canGenerate || planning"
              @click="generatePlan"
            >
              Regenerate from scratch
            </button>
          </template>
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
                  'faw-btn--run': canSavePreview && !executing && hasPlanSession,
                }"
                :disabled="
                  !canSavePreview ||
                  executing ||
                  saving ||
                  planning ||
                  activeBatch?.status === 'running'
                "
                @click="confirmExecute"
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
          class="text-xs faw-create-data-alert"
          :class="{
            'faw-create-data-alert--warning': nextAction.type === 'warning',
            'faw-create-data-alert--info': nextAction.type === 'info',
            'faw-create-data-alert--error': nextAction.type === 'error',
          }"
          :message="nextAction.text"
        />

        <!-- Humanized progress (default) -->
        <div
          v-if="planning || (humanProgress && progressLines.length)"
          class="rounded border border-[var(--app-border)] p-3 space-y-2"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="text-[13px] text-ink font-medium">
              {{
                planning
                  ? planningMode === "refine"
                    ? "Refining plan…"
                    : "Generating plan…"
                  : "Plan finished"
              }}
            </div>
            <span class="text-[13px] text-ink-muted tabular-nums shrink-0">
              {{ humanProgress?.pct ?? 0 }}%
            </span>
          </div>
          <div
            class="h-1.5 w-full rounded-full bg-[var(--app-border)] overflow-hidden"
            role="progressbar"
            :aria-valuenow="humanProgress?.pct ?? 0"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="h-full rounded-full bg-[var(--app-accent,#3b82f6)] transition-[width] duration-500 ease-out"
              :style="{ width: `${humanProgress?.pct ?? 0}%` }"
            />
          </div>
          <div class="text-[13px] text-ink-muted">
            {{ humanProgress?.label || "Starting…" }}
          </div>
          <div class="text-[13px] text-ink-faint">
            Step {{ (humanProgress?.stageIndex ?? 0) + 1 }} of
            {{ humanProgress?.totalStages ?? 6 }}
          </div>
          <button
            v-if="progressLines.length"
            type="button"
            class="text-[13px] text-ink-muted underline"
            @click="showPlannerLog = !showPlannerLog"
          >
            {{ showPlannerLog ? "Hide" : "Show" }} planner activity ({{
              progressLines.length
            }})
          </button>
          <div
            v-if="showPlannerLog && progressLines.length"
            class="max-h-36 overflow-y-auto space-y-1 pt-1 border-t border-[var(--app-border)]"
          >
            <div
              v-for="(line, i) in progressLines"
              :key="`${line.step}-${i}-${line.label}`"
              class="text-[13px] font-mono text-ink truncate"
            >
              <span class="text-ink-faint">{{ line.step }}</span>
              · {{ line.label }}
              <span v-if="line.detail" class="text-ink-muted">
                · {{ line.detail }}</span
              >
            </div>
          </div>
        </div>
        <button
          v-else-if="progressLines.length && !planning"
          type="button"
          class="text-[13px] text-ink-muted underline"
          @click="showPlannerLog = true"
        >
          Show planner log ({{ progressLines.length }})
        </button>

        <!-- Questions + Follow-up as one chat turn -->
        <div
          v-if="hasPlanSession"
          class="faw-create-data-conversation rounded border border-[var(--app-border)] p-3 space-y-3"
        >
          <div class="text-sm font-medium text-ink">Conversation</div>
          <div
            v-if="planQuestions.length"
            class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 space-y-1.5"
          >
            <div class="text-[13px] font-semibold text-amber-950 uppercase tracking-wide">
              Needs clarification / validation
            </div>
            <ul class="m-0 pl-4 text-[13px] text-amber-950 space-y-1.5 leading-snug">
              <li v-for="(q, i) in planQuestions" :key="i">{{ q }}</li>
            </ul>
          </div>
          <div
            v-else-if="planSteps.length"
            class="text-[13px] text-ink-muted"
          >
            Plan has {{ planSteps.length }} steps. Reply below to refine, or
            Execute when ready.
          </div>
          <div class="space-y-1">
            <div class="text-[13px] font-medium text-ink-muted uppercase tracking-wide">
              Your reply
            </div>
            <div class="flex gap-2 items-end">
              <a-textarea
                v-model:value="followUp"
                :rows="2"
                class="flex-1"
                :disabled="planning || Boolean(featureDisabledReason)"
                placeholder='e.g. "Only 5 working days from Sep 1, skip Sep 15"'
                @keydown.enter.exact.prevent="refinePlan"
              />
              <button
                type="button"
                class="faw-btn faw-btn--run !flex-none"
                :disabled="!canRefine"
                @click="refinePlan"
              >
                {{ planning && planningMode === "refine" ? "Refining…" : "Refine plan" }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="planNotes.length">
          <button
            type="button"
            class="text-[13px] text-ink-muted underline"
            @click="showPlanNotes = !showPlanNotes"
          >
            {{ showPlanNotes ? "Hide" : "Show" }} planner notes ({{ planNotes.length }})
          </button>
          <div
            v-if="showPlanNotes"
            class="mt-1 text-[13px] text-ink-muted space-y-1"
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
            <div class="text-[13px] text-ink-muted">
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
              class="inline-flex items-center gap-1 rounded border border-[var(--app-border)] px-2 py-0.5 text-[13px] font-mono"
            >
              {{ c.collection }}
              <span class="text-green-700">{{ c.success }}</span>
              <span v-if="c.failed" class="text-red-600">/ {{ c.failed }} fail</span>
            </span>
          </div>

          <p
            v-if="executionSummary.error"
            class="m-0 text-[13px] text-red-600"
          >
            {{ executionSummary.error }}
          </p>

          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px] border-collapse">
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
          class="text-[13px] text-ink-muted"
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
          v-if="showStepsCards"
          class="space-y-3"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <div class="text-sm font-medium text-ink">
              Steps ({{ planSteps.length }})
            </div>
            <button
              type="button"
              class="text-[13px] text-ink-muted underline"
              @click="forceShowEditors = !forceShowEditors"
            >
              {{ forceShowEditors ? "Hide all step JSON" : "Show all step JSON" }}
            </button>
          </div>

          <div
            v-for="(s, idx) in planSteps"
            :key="s.step_id"
            class="rounded border border-[var(--app-border)] p-3 space-y-2"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-[13px] font-medium text-ink">
                  {{ idx + 1 }}.
                  <span
                    class="uppercase tracking-wide text-[13px] px-1.5 py-0.5 rounded ml-1"
                    :class="{
                      'bg-green-50 text-green-800': s.op === 'insert',
                      'bg-amber-50 text-amber-800': s.op === 'update',
                      'bg-red-50 text-red-700': s.op === 'delete',
                    }"
                    >{{ s.op }}</span
                  >
                  <span class="font-mono ml-1">{{ s.collection }}</span>
                </div>
                <div class="text-[13px] text-ink-muted mt-0.5">
                  {{ s.description || s.step_id }}
                </div>
              </div>
              <button
                type="button"
                class="text-[13px] text-ink-muted underline shrink-0"
                @click="toggleStepJson(s.step_id)"
              >
                {{ isStepJsonOpen(s.step_id) ? "Hide JSON" : "JSON" }}
              </button>
            </div>

            <!-- Insert: field cards -->
            <div v-if="s.op === 'insert'" class="space-y-1">
              <div class="text-[13px] text-ink-muted">Fields to create</div>
              <dl
                v-if="stepFieldEntries(stepDataForDisplay(s)).length"
                class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-[13px]"
              >
                <template
                  v-for="f in stepFieldEntries(stepDataForDisplay(s))"
                  :key="f.key"
                >
                  <dt class="font-mono text-ink-muted truncate">{{ f.key }}</dt>
                  <dd class="font-mono text-ink m-0 break-all">{{ f.value }}</dd>
                </template>
              </dl>
              <div v-else class="text-[13px] text-ink-faint">No fields</div>
            </div>

            <!-- Update: target + changes -->
            <div v-else-if="s.op === 'update'" class="space-y-2">
              <div>
                <div class="text-[13px] text-ink-muted mb-1">Match record (filter)</div>
                <dl
                  v-if="stepFieldEntries(stepFilterForDisplay(s)).length"
                  class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-[13px]"
                >
                  <template
                    v-for="f in stepFieldEntries(stepFilterForDisplay(s))"
                    :key="f.key"
                  >
                    <dt class="font-mono text-ink-muted truncate">{{ f.key }}</dt>
                    <dd class="font-mono text-ink m-0 break-all">{{ f.value }}</dd>
                  </template>
                </dl>
                <div v-else class="text-[13px] text-ink-faint">Empty filter</div>
              </div>
              <div>
                <div class="text-[13px] text-ink-muted mb-1">
                  Fields that will change
                </div>
                <dl
                  v-if="stepFieldEntries(stepDataForDisplay(s)).length"
                  class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-[13px]"
                >
                  <template
                    v-for="f in stepFieldEntries(stepDataForDisplay(s))"
                    :key="f.key"
                  >
                    <dt class="font-mono text-amber-800/80 truncate">{{ f.key }}</dt>
                    <dd class="font-mono text-ink m-0 break-all bg-amber-50/60 px-1 rounded">
                      {{ f.value }}
                    </dd>
                  </template>
                </dl>
                <div v-else class="text-[13px] text-ink-faint">No changes</div>
              </div>
            </div>

            <!-- Delete: identity -->
            <div v-else class="space-y-1">
              <div class="text-[13px] text-red-700">Record to delete</div>
              <div
                v-if="stepIdentityLabels(s).length"
                class="text-[13px] font-mono text-ink space-y-0.5"
              >
                <div v-for="(lab, li) in stepIdentityLabels(s)" :key="li">
                  {{ lab }}
                </div>
              </div>
              <dl
                v-else-if="stepFieldEntries(stepFilterForDisplay(s)).length"
                class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-[13px]"
              >
                <template
                  v-for="f in stepFieldEntries(stepFilterForDisplay(s))"
                  :key="f.key"
                >
                  <dt class="font-mono text-ink-muted truncate">{{ f.key }}</dt>
                  <dd class="font-mono text-ink m-0 break-all">{{ f.value }}</dd>
                </template>
              </dl>
              <div v-else class="text-[13px] text-ink-faint">No filter</div>
            </div>

            <div
              v-if="isStepJsonOpen(s.step_id)"
              class="space-y-2 pt-2 border-t border-[var(--app-border)]"
            >
              <label class="flex flex-col gap-1 text-[13px] text-ink-muted">
                data
                <a-textarea
                  v-model:value="editingData[s.step_id]"
                  :rows="4"
                  class="font-mono text-[13px]"
                  placeholder="null / JSON document or row"
                />
              </label>
              <label
                v-if="s.op !== 'insert'"
                class="flex flex-col gap-1 text-[13px] text-ink-muted"
              >
                filter
                <a-textarea
                  v-model:value="editingFilter[s.step_id]"
                  :rows="2"
                  class="font-mono text-[13px]"
                  placeholder="WHERE / Mongo filter JSON"
                />
              </label>
            </div>

            <div
              v-if="resultFor(s.step_id)"
              class="text-[13px]"
              :class="statusColor[resultFor(s.step_id)!.status]"
            >
              Result: {{ resultFor(s.step_id)!.status }}
              <span
                v-if="resultFor(s.step_id)!.createdId"
                class="font-mono text-ink-muted"
              >
                · {{ resultFor(s.step_id)!.createdId }}
              </span>
            </div>
          </div>
        </div>
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
            <code class="text-[13px] text-ink">{{ b.batchId }}</code>
            <span class="text-[13px]" :class="statusColor[b.status]">{{
              b.status
            }}</span>
          </div>
          <div class="text-[13px] text-ink-muted mt-1 line-clamp-1">
            {{ batchPreviewLine(b) }}
          </div>
          <div class="text-[13px] text-ink-faint mt-0.5 line-clamp-2">
            {{ b.prompt }}
          </div>
          <div class="text-[13px] text-ink-faint mt-1">
            {{ new Date(b.createdAt).toLocaleString() }}
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.faw-create-data-alert :deep(.ant-alert) {
  color: #1c1917;
  align-items: flex-start;
}
.faw-create-data-alert :deep(.ant-alert-message) {
  color: inherit;
  font-weight: 500;
}
.faw-create-data-alert--warning :deep(.ant-alert) {
  background: #fffbeb;
  border-color: #f59e0b;
  color: #78350f;
}
.faw-create-data-alert--info :deep(.ant-alert) {
  background: #eff6ff;
  border-color: #3b82f6;
  color: #1e3a8a;
}
.faw-create-data-alert--error :deep(.ant-alert) {
  background: #fef2f2;
  border-color: #ef4444;
  color: #7f1d1d;
}
.faw-create-data-alert :deep(.ant-alert-icon) {
  color: inherit;
}
</style>
