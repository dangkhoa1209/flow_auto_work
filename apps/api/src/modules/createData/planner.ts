import type { CreateDataPlanResponse, CreateDataStepPlan } from "./types.js";

/** Hard cap for heuristic fallback only (AI planner follows the stated count). */
const MAX_ENTITY_COUNT = 1000;

function clampCount(n: number, max = MAX_ENTITY_COUNT): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), max);
}

/**
 * Count must sit next to an entity word — never a bare digit (years like 2026
 * used to clamp and spawn dozens of bogus inserts).
 * If the scenario does not mention a count → fallback **1**.
 */
export function extractEntityCount(text: string, fallback = 1): number {
  const patterns = [
    /(?:tạo|create|sinh|seed)\s+(\d+)\s*(?:nhân viên|nhan vien|staff|employee|nv|user|users|người dùng|nguoi dung)/i,
    /(\d+)\s*(?:nhân viên|nhan vien|staff|employee|nv|users?|người dùng|nguoi dung)\b/i,
    /(?:tạo|create|sinh)\s+(\d+)\s*(?:đơn|order)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return clampCount(Number(m[1]));
  }
  return fallback;
}

function slugStep(prefix: string, i: number): string {
  return `${prefix}_${i + 1}`;
}

function wantsStaff(prompt: string): boolean {
  return (
    /\b(staff|employee|employees)\b/i.test(prompt) ||
    /nhân viên|nhan vien|\bnv\b/i.test(prompt)
  );
}

function wantsUsers(prompt: string): boolean {
  // Explicit account/login users only — not "nhân viên".
  if (wantsStaff(prompt)) return false;
  return (
    /\b(users?|account|accounts)\b/i.test(prompt) ||
    /người dùng|nguoi dung/i.test(prompt)
  );
}

/**
 * Deterministic Seed Planner (fallback when Cursor AI is unavailable).
 * Prefer AI planner; this path must not invent "50 users" from a year digit.
 */
export function buildSeedPlan(promptRaw: string): CreateDataPlanResponse {
  const prompt = promptRaw.trim();
  const notes: string[] = [
    "Heuristic fallback only — prefer AI planner (code_map UI→BE) when Cursor is available.",
    "Plan writes directly to project Connect DB (insert/update/delete).",
    "Review collection/table names and fields against real schema before execute.",
    "Placeholders like {{create_staff_1._id}} resolve from prior step write results.",
  ];
  const questions: string[] = [];

  if (!prompt) {
    return {
      steps: [],
      questions: ["Describe the scenario (entities, counts, statuses)."],
      notes,
    };
  }

  const lower = prompt.toLowerCase();
  const staffMode = wantsStaff(prompt);
  const userMode = wantsUsers(prompt);
  const wantsOrders =
    /\b(order|orders|request)\b/i.test(prompt) ||
    /đơn(?:\s+hàng)?|yêu cầu/i.test(prompt);
  const wantsCompleted =
    /\b(completed|approved|done|success)\b/i.test(prompt) ||
    /hoàn thành/i.test(prompt);
  const wantsPending =
    /\b(pending|draft)\b/i.test(prompt) ||
    /chờ|đang chờ/i.test(prompt);

  if (!staffMode && !userMode && !wantsOrders) {
    questions.push(
      "Which collection/table should be seeded first (staffs, users, orders, …)?",
    );
    questions.push(
      "Confirm Connect DB is enabled for this project (Admin → Connect DB).",
    );
    return { steps: [], questions, notes };
  }

  const entityCount =
    staffMode || userMode ? extractEntityCount(prompt, 1) : 0;
  const steps: CreateDataStepPlan[] = [];
  const collection = staffMode ? "staffs" : "users";
  const stepPrefix = staffMode ? "create_staff" : "create_user";
  const idField = staffMode ? "_id" : "id";

  for (let i = 0; i < entityCount; i++) {
    const stepId = slugStep(stepPrefix, i);
    if (staffMode) {
      steps.push({
        step_id: stepId,
        description: `Insert staff #${i + 1}`,
        op: "insert",
        collection,
        data: {
          full_name: `Seed Staff ${i + 1}`,
          staff_code: `SEED_${i + 1}`,
          email: `seed.staff${i + 1}@example.com`,
        },
        filter: null,
        depends_on: [],
        rollback: true,
      });
    } else {
      steps.push({
        step_id: stepId,
        description: `Insert user #${i + 1}`,
        op: "insert",
        collection,
        data: {
          email: `seed.user${i + 1}@example.com`,
          name: `Seed User ${i + 1}`,
        },
        filter: null,
        depends_on: [],
        rollback: true,
      });
    }
  }

  if (wantsOrders) {
    if (!userMode && !staffMode) {
      questions.push(
        "Orders need a parent id — should we insert users/staff first, or reuse an existing id?",
      );
    }
    const perUserCompleted =
      wantsCompleted || (!wantsCompleted && !wantsPending);
    const perUserPending =
      wantsPending || (!wantsCompleted && !wantsPending);
    const both =
      (wantsCompleted && wantsPending) ||
      /mỗi user.*(hoàn thành|completed).*(pending|chờ)/i.test(prompt) ||
      /each user.*(completed|approved).*(pending)/i.test(lower);

    const makeOrder = (
      userIdx: number,
      kind: "completed" | "pending",
      ordIdx: number,
    ) => {
      const parentStep = slugStep(stepPrefix, userIdx);
      const stepId = `create_order_${kind}_${userIdx + 1}_${ordIdx + 1}`;
      steps.push({
        step_id: stepId,
        description: `Insert ${kind} order for ${staffMode ? "staff" : "user"} #${userIdx + 1}`,
        op: "insert",
        collection: "orders",
        data: {
          [staffMode ? "staff_id" : "user_id"]: `{{${parentStep}.${idField}}}`,
          status: kind === "completed" ? "completed" : "pending",
          note: `Seed ${kind} order (batch)`,
        },
        filter: null,
        depends_on: staffMode || userMode ? [parentStep] : [],
        rollback: true,
      });
    };

    const loopUsers = Math.max(entityCount, staffMode || userMode ? 0 : 1);
    for (let i = 0; i < loopUsers; i++) {
      if (both || perUserCompleted) makeOrder(i, "completed", 0);
      if (both || perUserPending) makeOrder(i, "pending", 0);
    }
  }

  if (steps.length === 0) {
    questions.push(
      "Could not infer steps — name collections/tables, counts, and desired fields.",
    );
  } else if (staffMode) {
    notes.push(
      "Heuristic used collection staffs for «nhân viên» — align fields with Staff model before execute.",
    );
  } else {
    notes.push(
      "Default collections users/orders are placeholders — align with project schema before run.",
    );
  }

  return { steps, questions, notes };
}

/**
 * When Pass 1 scoped to staff but the plan only inserts users (classic AI/heuristic
 * mistake), block execute and ask for a corrected plan.
 */
export function assertPlanEntityAlignment(
  prompt: string,
  plan: CreateDataPlanResponse,
  scopedCollections: string[] = [],
): CreateDataPlanResponse {
  const staffIntent =
    wantsStaff(prompt) ||
    scopedCollections.some((c) => /staff/i.test(c));
  if (!staffIntent || !plan.steps.length) return plan;

  const insertCols = plan.steps
    .filter((s) => s.op === "insert")
    .map((s) => s.collection.toLowerCase());
  const hasStaff = insertCols.some((c) => /staff/.test(c));
  const hasUsersOnly =
    insertCols.length > 0 &&
    insertCols.every((c) => c === "users" || c === "user") &&
    !hasStaff;

  if (!hasUsersOnly) return plan;

  return {
    steps: [],
    questions: [
      ...plan.questions,
      'Scenario is about employees (nhân viên / staff), but the plan only inserts into "users". Regenerate or Refine so primary inserts use the Staff collection (usually "staffs"), not users.',
    ],
    notes: [
      ...plan.notes,
      "Blocked: staff intent misaligned with users-only inserts.",
    ],
  };
}
