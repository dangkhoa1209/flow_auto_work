import { AppError } from "../../utils/AppError.js";
import type {
  CreateDataBatch,
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

export function assertSafeApiBaseUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) {
    throw new AppError("apiBaseUrl required", 400, "create_data_base_required");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("apiBaseUrl is not a valid URL", 400, "create_data_bad_url");
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new AppError(
      "apiBaseUrl must be http(s)",
      400,
      "create_data_bad_url_scheme",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host.includes("prod") ||
    host.endsWith(".production") ||
    /(^|\.)prod\./.test(host)
  ) {
    throw new AppError(
      "apiBaseUrl looks like production — blocked",
      403,
      "create_data_production_url_blocked",
    );
  }
  return url;
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

/** Resolve `{{step_id.field}}` or `{{field}}` (current response id shorthand for rollback). */
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
        // Also try nested data.id patterns commonly returned by APIs
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

function pickCreatedId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  for (const key of ["id", "_id", "user_id", "order_id"]) {
    const v = r[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  const data = r.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    for (const key of ["id", "_id"]) {
      const v = d[key];
      if (typeof v === "string" || typeof v === "number") return String(v);
    }
  }
  return null;
}

async function callStep(
  apiBaseUrl: string,
  step: CreateDataStepPlan,
  outputs: Record<string, unknown>,
  authToken?: string,
): Promise<{ result: CreateDataStepResult; body: unknown }> {
  const startedAt = new Date().toISOString();
  const endpoint = String(
    resolvePlaceholders(step.endpoint, outputs) ?? step.endpoint,
  );
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${apiBaseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const payload = step.payload
    ? (resolvePlaceholders(step.payload, outputs) as Record<string, unknown>)
    : null;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (payload && step.method !== "GET") {
    headers["Content-Type"] = "application/json";
  }
  if (authToken?.trim()) {
    headers.Authorization = authToken.trim().startsWith("Bearer ")
      ? authToken.trim()
      : `Bearer ${authToken.trim()}`;
  }

  try {
    const res = await fetch(url, {
      method: step.method,
      headers,
      body:
        payload && step.method !== "GET" ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    const finishedAt = new Date().toISOString();
    if (!res.ok) {
      return {
        body,
        result: {
          step_id: step.step_id,
          status: "failed",
          httpStatus: res.status,
          response: body,
          error: `HTTP ${res.status}`,
          startedAt,
          finishedAt,
          createdId: null,
        },
      };
    }
    return {
      body,
      result: {
        step_id: step.step_id,
        status: "success",
        httpStatus: res.status,
        response: body,
        error: null,
        startedAt,
        finishedAt,
        createdId: pickCreatedId(body),
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
  authToken?: string,
): Promise<{
  results: CreateDataStepResult[];
  status: CreateDataBatch["status"];
  error: string | null;
}> {
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

    const { result, body } = await callStep(
      batch.apiBaseUrl,
      step,
      outputs,
      authToken,
    );
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

export async function rollbackBatchSteps(
  batch: CreateDataBatch,
  authToken?: string,
): Promise<CreateDataStepResult[]> {
  const out: CreateDataStepResult[] = [];
  // Reverse successful creates
  const success = [...batch.results]
    .filter((r) => r.status === "success" && r.createdId)
    .reverse();

  for (const r of success) {
    const plan = batch.steps.find((s) => s.step_id === r.step_id);
    if (!plan?.rollback_endpoint) {
      out.push({
        step_id: r.step_id,
        status: "skipped",
        error: "No rollback_endpoint",
      });
      continue;
    }
    const endpoint = String(
      resolvePlaceholders(plan.rollback_endpoint, {}, r.response) ||
        plan.rollback_endpoint.replace("{{id}}", String(r.createdId)),
    );
    const fakeStep: CreateDataStepPlan = {
      step_id: `rollback_${r.step_id}`,
      description: `Rollback ${r.step_id}`,
      method: "DELETE",
      endpoint,
      payload: null,
      depends_on: [],
    };
    const { result } = await callStep(
      batch.apiBaseUrl,
      fakeStep,
      {},
      authToken,
    );
    out.push({ ...result, step_id: r.step_id });
  }
  return out;
}
