import { AppError } from "../../utils/AppError.js";
import {
  getBaProject,
  getEffectiveBaFeatures,
  isBaCreateDataDbAccessAllowed,
  isBaDbAccessAllowed,
  resolveBaCreateDataDb,
  resolveBaProjectDb,
  toPublicBaCreateData,
  toPublicBaDb,
} from "../../workspace/baStore.js";
import {
  assertPlanPlaceholdersReferToSteps,
  assertSafeCreateDataTarget,
  assertSafeEnvironment,
  collectPlaceholderStepRefs,
  executeBatchSteps,
  isCreateDataDbOp,
  rollbackBatchSteps,
} from "./executor.js";
import { buildSeedPlan } from "./planner.js";
import { runCreateDataPlannerAgent, stopCreateDataPlanner } from "./agentPlanner.js";
import {
  getCreateDataBatch,
  insertCreateDataBatch,
  listCreateDataBatches,
  updateCreateDataBatch,
} from "./store.js";
import type {
  CreateDataBatch,
  CreateDataDbSnapshot,
  CreateDataEnvironment,
  CreateDataPlanResponse,
  CreateDataStepPlan,
} from "./types.js";

export type { CreateDataBatch, CreateDataPlanResponse, CreateDataStepPlan };
export { ensureCreateDataIndexes } from "./store.js";
export { buildSeedPlan } from "./planner.js";
export { stopCreateDataPlanner };

async function assertCreateDataFeatureOn() {
  const { flags, devMode } = await getEffectiveBaFeatures();
  if (devMode || flags.createData !== "hide") return;
  throw new AppError(
    'Feature "Create Data" is disabled — ask an admin to enable it (lab or production).',
    403,
    "ba_feature_disabled",
  );
}

function newIds() {
  const raw = crypto.randomUUID().replace(/-/g, "");
  return {
    id: `bcd_${raw.slice(0, 16)}`,
    batchId: `seed_${raw.slice(0, 12)}`,
  };
}

function normalizeSteps(raw: unknown): CreateDataStepPlan[] {
  if (!Array.isArray(raw)) {
    throw new AppError("steps must be an array", 400, "create_data_bad_steps");
  }
  return raw.map((s, i) => {
    const row = s as Partial<CreateDataStepPlan> & {
      method?: string;
      endpoint?: string;
      table?: string;
      payload?: Record<string, unknown>;
    };
    if (row.method || row.endpoint) {
      throw new AppError(
        "HTTP steps are no longer supported — regenerate the plan (DB insert/update/delete)",
        400,
        "create_data_http_deprecated",
      );
    }
    const step_id = String(row.step_id || "").trim() || `step_${i + 1}`;
    const op = String(row.op || "").toLowerCase();
    if (!isCreateDataDbOp(op)) {
      throw new AppError(
        `Invalid op on ${step_id} (insert|update|delete)`,
        400,
        "create_data_bad_op",
      );
    }
    const collection = String(row.collection || row.table || "").trim();
    if (!collection) {
      throw new AppError(
        `collection/table required on ${step_id}`,
        400,
        "create_data_bad_collection",
      );
    }
    const data =
      row.data && typeof row.data === "object"
        ? (row.data as Record<string, unknown>)
        : row.payload && typeof row.payload === "object"
          ? row.payload
          : null;
    const filter =
      row.filter && typeof row.filter === "object"
        ? (row.filter as Record<string, unknown>)
        : null;
    if (op === "insert" && !data) {
      throw new AppError(
        `data required on insert ${step_id}`,
        400,
        "create_data_bad_data",
      );
    }
    if (
      (op === "update" || op === "delete") &&
      (!filter || !Object.keys(filter).length)
    ) {
      throw new AppError(
        `non-empty filter required on ${op} ${step_id}`,
        400,
        "create_data_bad_filter",
      );
    }
    if (op === "update" && !data) {
      throw new AppError(
        `data required on update ${step_id}`,
        400,
        "create_data_bad_data",
      );
    }
    const depends_on = Array.isArray(row.depends_on)
      ? row.depends_on.map(String)
      : [];
    const autoDeps = collectPlaceholderStepRefs({ data, filter }).filter(
      (id) => id !== step_id && !depends_on.includes(id),
    );
    return {
      step_id,
      description: String(row.description || step_id),
      op,
      collection,
      data,
      filter,
      depends_on: [...depends_on, ...autoDeps],
      rollback: row.rollback === false ? false : true,
    };
  });
}

async function requireWriteDb(baProjectId: string): Promise<{
  cfg: NonNullable<Awaited<ReturnType<typeof resolveBaCreateDataDb>>>;
  snapshot: CreateDataDbSnapshot;
  seedEnabled: boolean;
}> {
  const project = await getBaProject(baProjectId);
  if (!project) {
    throw new AppError("Project not found", 404, "ba_project_not_found");
  }
  const seedCfg = toPublicBaCreateData(project.createData);
  if (!seedCfg.enabled) {
    throw new AppError(
      "Create Data is not enabled for this project — ask Admin to enable it",
      403,
      "create_data_disabled",
    );
  }
  // Prefer dedicated seed Connect; fall back to project Connect DB (Sync target).
  const hasSeedDb = isBaCreateDataDbAccessAllowed(project);
  const hasProjectDb = isBaDbAccessAllowed(project);
  if (!hasSeedDb && !hasProjectDb) {
    throw new AppError(
      "Create Data Connect DB is not configured — Admin → Projects → Create Data (or project Connect DB)",
      400,
      "create_data_db_required",
    );
  }
  const cfg =
    (await resolveBaCreateDataDb(baProjectId)) ||
    (await resolveBaProjectDb(baProjectId));
  if (!cfg) {
    throw new AppError(
      "Create Data Connect DB credentials unavailable",
      400,
      "create_data_db_unavailable",
    );
  }
  assertSafeCreateDataTarget(cfg);
  return {
    cfg,
    snapshot: {
      dialect: cfg.dialect,
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
    },
    seedEnabled: seedCfg.enabled,
  };
}

export async function createDataPlan(opts: {
  userId: string;
  prompt: string;
  baProjectId: string;
  environment?: string;
  /** Force heuristic only (tests / offline). */
  heuristicOnly?: boolean;
}): Promise<
  CreateDataPlanResponse & {
    planner: "ai" | "heuristic";
    suggestedDbTarget: CreateDataDbSnapshot | null;
  }
> {
  await assertCreateDataFeatureOn();
  const project = await getBaProject(opts.baProjectId);
  if (!project) {
    throw new AppError("Project not found", 404, "ba_project_not_found");
  }
  const environment = assertSafeEnvironment(opts.environment || "staging");
  const seedCfg = toPublicBaCreateData(project.createData);
  if (!seedCfg.enabled) {
    throw new AppError(
      "Create Data is not enabled for this project — ask Admin to enable it",
      403,
      "create_data_disabled",
    );
  }
  const projectDb = toPublicBaDb(project.db);
  const seedDb = seedCfg.db;
  const suggestedFrom =
    seedDb.configured && seedDb.enabled
      ? seedDb
      : projectDb.configured && projectDb.enabled
        ? projectDb
        : null;
  const suggestedDbTarget =
    suggestedFrom?.dialect && suggestedFrom.host && suggestedFrom.database
      ? {
          dialect: suggestedFrom.dialect,
          host: suggestedFrom.host,
          port: suggestedFrom.port || 0,
          database: suggestedFrom.database,
        }
      : null;

  if (opts.heuristicOnly) {
    const plan = buildSeedPlan(opts.prompt);
    return { ...plan, planner: "heuristic", suggestedDbTarget };
  }

  const plan = await runCreateDataPlannerAgent({
    userId: opts.userId,
    baProjectId: opts.baProjectId,
    prompt: opts.prompt,
    environment,
  });
  return { ...plan, suggestedDbTarget };
}

export async function createDataCreateBatch(opts: {
  userId: string;
  baProjectId: string;
  prompt: string;
  environment: string;
  steps: unknown;
  questions?: string[];
}): Promise<CreateDataBatch> {
  await assertCreateDataFeatureOn();
  const environment = assertSafeEnvironment(opts.environment);
  const { snapshot } = await requireWriteDb(opts.baProjectId);
  const steps = normalizeSteps(opts.steps);
  if (!steps.length) {
    throw new AppError("Plan has no steps", 400, "create_data_empty_plan");
  }
  assertPlanPlaceholdersReferToSteps(steps);
  const now = new Date().toISOString();
  const { id, batchId } = newIds();
  const doc: CreateDataBatch = {
    id,
    batchId,
    userId: opts.userId,
    baProjectId: opts.baProjectId,
    prompt: opts.prompt.trim(),
    environment,
    mode: "db",
    dbTarget: snapshot,
    status: "preview",
    steps,
    results: steps.map((s) => ({
      step_id: s.step_id,
      status: "pending",
    })),
    questions: Array.isArray(opts.questions)
      ? opts.questions.map(String)
      : [],
    createdAt: now,
    updatedAt: now,
  };
  return insertCreateDataBatch(doc);
}

export async function createDataListBatches(opts: {
  userId: string;
  baProjectId: string;
  limit?: number;
}): Promise<CreateDataBatch[]> {
  await assertCreateDataFeatureOn();
  return listCreateDataBatches(opts);
}

export async function createDataGetBatch(opts: {
  userId: string;
  id: string;
}): Promise<CreateDataBatch> {
  await assertCreateDataFeatureOn();
  const batch = await getCreateDataBatch(opts.id);
  if (!batch || batch.userId !== opts.userId) {
    throw new AppError("Batch not found", 404, "create_data_not_found");
  }
  return batch;
}

export async function createDataExecuteBatch(opts: {
  userId: string;
  id: string;
}): Promise<CreateDataBatch> {
  await assertCreateDataFeatureOn();
  const batch = await createDataGetBatch({ userId: opts.userId, id: opts.id });
  if (batch.status === "running") {
    throw new AppError("Batch already running", 409, "create_data_busy");
  }
  assertSafeEnvironment(batch.environment);
  const { cfg } = await requireWriteDb(batch.baProjectId);

  const startedAt = new Date().toISOString();
  await updateCreateDataBatch(batch.id, {
    status: "running",
    startedAt,
    error: null,
  });

  try {
    const { results, status, error } = await executeBatchSteps(batch, cfg);
    const updated = await updateCreateDataBatch(batch.id, {
      status,
      results,
      error,
      finishedAt: new Date().toISOString(),
    });
    return updated || { ...batch, status, results, error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const updated = await updateCreateDataBatch(batch.id, {
      status: "failed",
      error: msg,
      finishedAt: new Date().toISOString(),
    });
    if (updated) return updated;
    throw e;
  }
}

export async function createDataRollbackBatch(opts: {
  userId: string;
  id: string;
}): Promise<CreateDataBatch> {
  await assertCreateDataFeatureOn();
  const batch = await createDataGetBatch({ userId: opts.userId, id: opts.id });
  if (!["success", "partial", "failed"].includes(batch.status)) {
    throw new AppError(
      "Only executed batches can be rolled back",
      409,
      "create_data_rollback_state",
    );
  }
  assertSafeEnvironment(batch.environment);
  const { cfg } = await requireWriteDb(batch.baProjectId);

  const rollbackResults = await rollbackBatchSteps(batch, cfg);
  const updated = await updateCreateDataBatch(batch.id, {
    status: "rolled_back",
    results: batch.results.map((r) => {
      const rb = rollbackResults.find((x) => x.step_id === r.step_id);
      if (!rb) return r;
      return {
        ...r,
        error: rb.status === "success" ? null : rb.error || r.error,
      };
    }),
    finishedAt: new Date().toISOString(),
  });
  return updated || { ...batch, status: "rolled_back" };
}

export function parseEnvironment(raw: unknown): CreateDataEnvironment {
  return assertSafeEnvironment(String(raw || "staging"));
}
