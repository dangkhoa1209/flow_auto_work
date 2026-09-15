import { isCreateDataDbOp } from "./executor.js";
import type { CreateDataPlanResponse, CreateDataStepPlan } from "./types.js";

function asStep(raw: unknown, index: number): CreateDataStepPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const step_id = String(row.step_id || "").trim() || `step_${index + 1}`;

  // Reject legacy HTTP plans early
  if (row.method != null || row.endpoint != null) return null;

  const opRaw = String(row.op || "").toLowerCase();
  if (!isCreateDataDbOp(opRaw)) return null;
  const collection = String(row.collection || row.table || "").trim();
  if (!collection) return null;

  const data =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null;
  const filter =
    row.filter && typeof row.filter === "object" && !Array.isArray(row.filter)
      ? (row.filter as Record<string, unknown>)
      : null;

  if (opRaw === "insert" && !data) return null;
  if ((opRaw === "update" || opRaw === "delete") && !filter) return null;
  if (opRaw === "update" && !data) return null;

  return {
    step_id,
    description: String(row.description || step_id),
    op: opRaw,
    collection,
    data,
    filter,
    depends_on: Array.isArray(row.depends_on)
      ? row.depends_on.map(String)
      : [],
    rollback: row.rollback === false ? false : true,
  };
}

/** Format AI question entry (string or {field, reason}) for UI. */
export function formatPlanQuestion(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    const field = String(row.field || row.name || "").trim();
    const reason = String(row.reason || row.message || row.error || "").trim();
    if (field && reason) return `${field}: ${reason}`;
    if (reason) return reason;
    if (field) return field;
  }
  const s = String(raw ?? "").trim();
  return s === "[object Object]" ? "" : s;
}

function tryParsePlanObject(text: string): CreateDataPlanResponse | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
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
    const questionsRaw = Array.isArray(planRoot.questions)
      ? planRoot.questions
      : Array.isArray(obj.questions)
        ? obj.questions
        : [];
    const questions = questionsRaw
      .map(formatPlanQuestion)
      .filter((q) => Boolean(q));
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
