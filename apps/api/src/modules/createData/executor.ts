import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import { runBaWriteOp } from "../../plugins/baDb/write.js";
import { AppError } from "../../utils/AppError.js";
import type {
  CreateDataBatch,
  CreateDataDbOp,
  CreateDataEnvironment,
  CreateDataStepPlan,
  CreateDataStepResult,
} from "./types.js";

const BLOCKED_ENV = new Set(["production", "prod", "live"]);

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function assertSafeEnvironment(env: string): CreateDataEnvironment {
  const normalized = env.trim().toLowerCase();
  if (BLOCKED_ENV.has(normalized)) {
    throw new AppError(
      "Create Data cannot run against Production",
      403,
      "create_data_production_blocked",
    );
  }
  if (
    normalized === "local" ||
    normalized === "staging" ||
    normalized === "development"
  ) {
    return normalized;
  }
  throw new AppError(
    "environment must be local | staging | development",
    400,
    "create_data_bad_environment",
  );
}

/** Block hosts that look like production Connect DB. */
export function assertSafeDbHost(host: string): void {
  const h = host.trim().toLowerCase();
  if (
    h.includes("prod") ||
    h.endsWith(".production") ||
    /(^|\.)prod\./.test(h)
  ) {
    throw new AppError(
      "Connect DB host looks like production — blocked",
      403,
      "create_data_production_db_blocked",
    );
  }
}

function getByPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Resolve `{{step_id.field}}` placeholders in strings / nested objects. */
export function resolvePlaceholders(
  value: unknown,
  outputs: Record<string, unknown>,
  selfResponse?: unknown,
): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_RE, (_m, expr: string) => {
      const key = expr.trim();
      if (!key.includes(".")) {
        const fromSelf = getByPath(selfResponse, key);
        if (fromSelf != null) return String(fromSelf);
        return "";
      }
      const [stepId, ...rest] = key.split(".");
      const fromStep = getByPath(outputs[stepId], rest.join("."));
      if (fromStep == null) {
        const dataPath = getByPath(outputs[stepId], ["data", ...rest].join("."));
        if (dataPath != null) return String(dataPath);
        return "";
      }
      return String(fromStep);
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolvePlaceholders(v, outputs, selfResponse));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolvePlaceholders(v, outputs, selfResponse);
    }
    return out;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function runDbStep(
  cfg: BaDbConnectionResolved,
  step: CreateDataStepPlan,
  outputs: Record<string, unknown>,
): Promise<{ result: CreateDataStepResult; body: unknown }> {
  const startedAt = new Date().toISOString();
  const data = step.data
    ? (resolvePlaceholders(step.data, outputs) as Record<string, unknown>)
    : null;
  const filter = step.filter
    ? (resolvePlaceholders(step.filter, outputs) as Record<string, unknown>)
    : null;

  try {
    const write = await runBaWriteOp(cfg, {
      op: step.op,
      collection: step.collection,
      data,
      filter,
    });
    const body = write.document || {
      createdId: write.createdId,
      matchedCount: write.matchedCount,
      modifiedCount: write.modifiedCount,
      deletedCount: write.deletedCount,
    };
    return {
      body,
      result: {
        step_id: step.step_id,
        status: "success",
        httpStatus: null,
        response: {
          ...write,
          document: write.document,
        },
        error: null,
        startedAt,
        finishedAt: new Date().toISOString(),
        createdId: write.createdId,
      },
    };
  } catch (e) {
    return {
      body: null,
      result: {
        step_id: step.step_id,
        status: "failed",
        httpStatus: null,
        response: null,
        error: e instanceof Error ? e.message : String(e),
        startedAt,
        finishedAt: new Date().toISOString(),
        createdId: null,
      },
    };
  }
}

export async function executeBatchSteps(
  batch: CreateDataBatch,
  cfg: BaDbConnectionResolved,
): Promise<{
  results: CreateDataStepResult[];
  status: CreateDataBatch["status"];
  error: string | null;
}> {
  assertSafeDbHost(cfg.host);
  const outputs: Record<string, unknown> = {};
  const results: CreateDataStepResult[] = [];
  let failed = false;
  let error: string | null = null;

  for (const step of batch.steps) {
    if (failed) {
      results.push({
        step_id: step.step_id,
        status: "skipped",
        error: "Skipped after prior failure",
      });
      continue;
    }
    if ((step as { method?: string }).method || (step as { endpoint?: string }).endpoint) {
      failed = true;
      error =
        "Legacy HTTP step detected — re-generate the plan (Create Data is DB-only now)";
      results.push({
        step_id: step.step_id,
        status: "failed",
        error,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      continue;
    }
    const missingDep = step.depends_on.find((d) => !(d in outputs));
    if (missingDep) {
      failed = true;
      error = `Missing dependency output: ${missingDep}`;
      results.push({
        step_id: step.step_id,
        status: "failed",
        error,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      continue;
    }

    const { result, body } = await runDbStep(cfg, step, outputs);
    results.push(result);
    if (result.status === "success") {
      outputs[step.step_id] = body;
    } else {
      failed = true;
      error = result.error || "Step failed";
    }
  }

  const successCount = results.filter((r) => r.status === "success").length;
  let status: CreateDataBatch["status"] = "success";
  if (failed && successCount === 0) status = "failed";
  else if (failed) status = "partial";

  return { results, status, error };
}

function rollbackFilterFor(
  dialect: string,
  createdId: string,
): Record<string, unknown> {
  if (dialect === "mongodb") {
    return { _id: createdId };
  }
  return { id: createdId };
}

export async function rollbackBatchSteps(
  batch: CreateDataBatch,
  cfg: BaDbConnectionResolved,
): Promise<CreateDataStepResult[]> {
  assertSafeDbHost(cfg.host);
  const out: CreateDataStepResult[] = [];
  const success = [...batch.results]
    .filter((r) => r.status === "success" && r.createdId)
    .reverse();

  for (const r of success) {
    const plan = batch.steps.find((s) => s.step_id === r.step_id);
    const wantRollback = plan?.rollback !== false && plan?.op === "insert";
    if (!wantRollback || !r.createdId) {
      out.push({
        step_id: r.step_id,
        status: "skipped",
        error: "No DB rollback for this step",
      });
      continue;
    }
    const fakeStep: CreateDataStepPlan = {
      step_id: `rollback_${r.step_id}`,
      description: `Rollback ${r.step_id}`,
      op: "delete",
      collection: plan.collection,
      data: null,
      filter: rollbackFilterFor(cfg.dialect, r.createdId),
      depends_on: [],
    };
    const { result } = await runDbStep(cfg, fakeStep, {});
    out.push({ ...result, step_id: r.step_id });
  }
  return out;
}

export function isCreateDataDbOp(raw: unknown): raw is CreateDataDbOp {
  const op = String(raw || "").toLowerCase();
  return op === "insert" || op === "update" || op === "delete";
}

export function asStepData(raw: unknown): Record<string, unknown> | null {
  return asRecord(raw);
}
