import type { CreateDataPlanResponse, CreateDataStepPlan } from "./types.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function asStep(raw: unknown, index: number): CreateDataStepPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const step_id = String(row.step_id || "").trim() || `step_${index + 1}`;
  const method = String(row.method || "POST").toUpperCase();
  if (!METHODS.has(method)) return null;
  const endpoint = String(row.endpoint || "").trim();
  if (!endpoint) return null;
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
}

function tryParsePlanObject(text: string): CreateDataPlanResponse | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    // Prefer { plan: { steps } } or { steps }
    const planRoot =
      obj.plan && typeof obj.plan === "object"
        ? (obj.plan as Record<string, unknown>)
        : obj;
    if (!Array.isArray(planRoot.steps) && !Array.isArray(obj.steps)) {
      return null;
    }
    const stepsRaw = Array.isArray(planRoot.steps)
      ? planRoot.steps
      : (obj.steps as unknown[]);
    const steps = stepsRaw
      .map((s, i) => asStep(s, i))
      .filter((s): s is CreateDataStepPlan => Boolean(s));
    const questions = Array.isArray(planRoot.questions)
      ? planRoot.questions.map(String)
      : Array.isArray(obj.questions)
        ? obj.questions.map(String)
        : [];
    const notes = Array.isArray(planRoot.notes)
      ? planRoot.notes.map(String)
      : Array.isArray(obj.notes)
        ? obj.notes.map(String)
        : [];
    return { steps, questions, notes };
  } catch {
    return null;
  }
}

function extractBalancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse Seed Planner JSON from Cursor agent output. */
export function parseSeedPlanFromAgent(
  text: string,
): CreateDataPlanResponse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed))) {
    const block = m[1]?.trim();
    if (!block) continue;
    const parsed = tryParsePlanObject(block);
    if (parsed && (parsed.steps.length || parsed.questions.length)) {
      return parsed;
    }
  }

  let i = 0;
  while (i < trimmed.length) {
    const start = trimmed.indexOf("{", i);
    if (start < 0) break;
    const window = trimmed.slice(start, start + 400);
    if (!/"steps"\s*:/.test(window)) {
      i = start + 1;
      continue;
    }
    const slice = extractBalancedJson(trimmed, start);
    if (slice) {
      const parsed = tryParsePlanObject(slice);
      if (parsed && (parsed.steps.length || parsed.questions.length)) {
        return parsed;
      }
      i = start + slice.length;
    } else {
      i = start + 1;
    }
  }

  return null;
}
