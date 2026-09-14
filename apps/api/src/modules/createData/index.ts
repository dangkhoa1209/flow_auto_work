import { AppError } from "../../utils/AppError.js";
import {
  getBaProject,
  getEffectiveBaFeatures,
} from "../../workspace/baStore.js";
import {
  assertSafeApiBaseUrl,
  assertSafeEnvironment,
  executeBatchSteps,
  rollbackBatchSteps,
} from "./executor.js";
import { buildSeedPlan } from "./planner.js";
import {
  getCreateDataBatch,
  insertCreateDataBatch,
  listCreateDataBatches,
  updateCreateDataBatch,
} from "./store.js";
import type {
  CreateDataBatch,
  CreateDataEnvironment,
  CreateDataPlanResponse,
  CreateDataStepPlan,
} from "./types.js";

export type { CreateDataBatch, CreateDataPlanResponse, CreateDataStepPlan };
export { ensureCreateDataIndexes } from "./store.js";
export { buildSeedPlan } from "./planner.js";

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
    const row = s as Partial<CreateDataStepPlan>;
    const step_id = String(row.step_id || "").trim() || `step_${i + 1}`;
    const method = String(row.method || "POST").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new AppError(
        `Invalid method on ${step_id}`,
        400,
        "create_data_bad_method",
      );
    }
    const endpoint = String(row.endpoint || "").trim();
    if (!endpoint) {
      throw new AppError(
        `endpoint required on ${step_id}`,
        400,
        "create_data_bad_endpoint",
      );
    }
    return {
      step_id,
      description: String(row.description || step_id),
      method: method as CreateDataStepPlan["method"],
      endpoint,
      payload:
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : null,
      depends_on: Array.isArray(row.depends_on)
        ? row.depends_on.map(String)
        : [],
      rollback_endpoint: row.rollback_endpoint
        ? String(row.rollback_endpoint)
        : null,
    };
  });
}

export async function createDataPlan(opts: {
  prompt: string;
}): Promise<CreateDataPlanResponse> {
  await assertCreateDataFeatureOn();
  return buildSeedPlan(opts.prompt);
}

export async function createDataCreateBatch(opts: {
  userId: string;
  baProjectId: string;
  prompt: string;
  environment: string;
  apiBaseUrl: string;
  steps: unknown;
  questions?: string[];
}): Promise<CreateDataBatch> {
  await assertCreateDataFeatureOn();
  const project = await getBaProject(opts.baProjectId);
  if (!project) {
    throw new AppError("Project not found", 404, "ba_project_not_found");
  }
  const environment = assertSafeEnvironment(opts.environment);
  const apiBaseUrl = assertSafeApiBaseUrl(opts.apiBaseUrl);
  const steps = normalizeSteps(opts.steps);
  if (!steps.length) {
    throw new AppError("Plan has no steps", 400, "create_data_empty_plan");
  }
  const now = new Date().toISOString();
  const { id, batchId } = newIds();
  const doc: CreateDataBatch = {
    id,
    batchId,
    userId: opts.userId,
    baProjectId: opts.baProjectId,
    prompt: opts.prompt.trim(),
    environment,
    apiBaseUrl,
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
  authToken?: string;
}): Promise<CreateDataBatch> {
  await assertCreateDataFeatureOn();
  const batch = await createDataGetBatch({ userId: opts.userId, id: opts.id });
  if (batch.status === "running") {
    throw new AppError("Batch already running", 409, "create_data_busy");
  }
  assertSafeEnvironment(batch.environment);
  assertSafeApiBaseUrl(batch.apiBaseUrl);

  const startedAt = new Date().toISOString();
  await updateCreateDataBatch(batch.id, {
    status: "running",
    startedAt,
    error: null,
  });

  try {
    const { results, status, error } = await executeBatchSteps(
      batch,
      opts.authToken,
    );
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
  authToken?: string;
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
  assertSafeApiBaseUrl(batch.apiBaseUrl);

  const rollbackResults = await rollbackBatchSteps(batch, opts.authToken);
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
