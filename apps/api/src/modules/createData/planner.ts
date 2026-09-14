import type { CreateDataPlanResponse, CreateDataStepPlan } from "./types.js";

function clampCount(n: number, max = 50): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), max);
}

function extractCount(text: string, fallback = 1): number {
  const m =
    text.match(
      /(?:tạo|create|sinh)\s+(\d+)\s*(?:user|users|người|nhân viên|staff)/i,
    ) ||
    text.match(/(\d+)\s*(?:user|users|người|nhân viên|staff)/i) ||
    text.match(/(\d+)/);
  return clampCount(m ? Number(m[1]) : fallback);
}

function slugStep(prefix: string, i: number): string {
  return `${prefix}_${i + 1}`;
}

/**
 * Deterministic Seed Planner (v1).
 * Produces Connect DB insert/update steps with `{{step_id.field}}` placeholders.
 * When the prompt is ambiguous, returns clarifying questions instead of guessing.
 */
export function buildSeedPlan(promptRaw: string): CreateDataPlanResponse {
  const prompt = promptRaw.trim();
  const notes: string[] = [
    "Heuristic fallback only — prefer AI planner (code_map UI→BE) when Cursor is available.",
    "Plan writes directly to project Connect DB (insert/update/delete).",
    "Review collection/table names and fields against real schema before execute.",
    "Placeholders like {{create_user_1.id}} resolve from prior step write results.",
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
  const wantsUsers =
    /\b(user|users|staff|account)\b/i.test(prompt) ||
    /người dùng|nhân viên/i.test(prompt);
  const wantsOrders =
    /\b(order|orders|request)\b/i.test(prompt) ||
    /đơn(?:\s+hàng)?|yêu cầu/i.test(prompt);
  const wantsCompleted =
    /\b(completed|approved|done|success)\b/i.test(prompt) ||
    /hoàn thành/i.test(prompt);
  const wantsPending =
    /\b(pending|draft)\b/i.test(prompt) ||
    /chờ|đang chờ/i.test(prompt);

  if (!wantsUsers && !wantsOrders) {
    questions.push(
      "Which collection/table should be seeded first (users, staff, orders, …)?",
    );
    questions.push(
      "Confirm Connect DB is enabled for this project (Admin → Connect DB).",
    );
    return { steps: [], questions, notes };
  }

  const userCount = wantsUsers ? extractCount(prompt, 1) : 0;
  const steps: CreateDataStepPlan[] = [];

  for (let i = 0; i < userCount; i++) {
    const stepId = slugStep("create_user", i);
    steps.push({
      step_id: stepId,
      description: `Insert user #${i + 1}`,
      op: "insert",
      collection: "users",
      data: {
        email: `seed.user${i + 1}@example.com`,
        name: `Seed User ${i + 1}`,
      },
      filter: null,
      depends_on: [],
      rollback: true,
    });
  }

  if (wantsOrders) {
    if (!wantsUsers) {
      questions.push(
        "Orders need a user_id — should we insert users first, or reuse an existing id?",
      );
    }
    const perUserCompleted = wantsCompleted || (!wantsCompleted && !wantsPending);
    const perUserPending = wantsPending || (!wantsCompleted && !wantsPending);
    const both =
      (wantsCompleted && wantsPending) ||
      /mỗi user.*(hoàn thành|completed).*(pending|chờ)/i.test(prompt) ||
      /each user.*(completed|approved).*(pending)/i.test(lower);

    const makeOrder = (
      userIdx: number,
      kind: "completed" | "pending",
      ordIdx: number,
    ) => {
      const userStep = slugStep("create_user", userIdx);
      const stepId = `create_order_${kind}_${userIdx + 1}_${ordIdx + 1}`;
      steps.push({
        step_id: stepId,
        description: `Insert ${kind} order for user #${userIdx + 1}`,
        op: "insert",
        collection: "orders",
        data: {
          user_id: `{{${userStep}.id}}`,
          status: kind === "completed" ? "completed" : "pending",
          note: `Seed ${kind} order (batch)`,
        },
        filter: null,
        depends_on: wantsUsers ? [userStep] : [],
        rollback: true,
      });
    };

    const loopUsers = Math.max(userCount, wantsUsers ? 0 : 1);
    for (let i = 0; i < loopUsers; i++) {
      if (both || perUserCompleted) makeOrder(i, "completed", 0);
      if (both || perUserPending) makeOrder(i, "pending", 0);
    }
  }

  if (steps.length === 0) {
    questions.push(
      "Could not infer steps — name collections/tables, counts, and desired fields.",
    );
  } else {
    notes.push(
      "Default collections users/orders are placeholders — align with project schema before run.",
    );
  }

  return { steps, questions, notes };
}
