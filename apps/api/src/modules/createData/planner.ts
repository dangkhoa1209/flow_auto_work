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
 * Produces API-only steps with `{{step_id.field}}` placeholders — never DB inserts.
 * When the prompt is ambiguous, returns clarifying questions instead of guessing required fields.
 */
export function buildSeedPlan(promptRaw: string): CreateDataPlanResponse {
  const prompt = promptRaw.trim();
  const notes: string[] = [
    "Plan uses HTTP APIs only (no direct DB insert).",
    "Review and edit endpoints/payloads to match the project OpenAPI before execute.",
    "Placeholders like {{create_user_1.id}} resolve from prior step JSON responses.",
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
      "Which entity should be created first (user, staff, order, …) and via which API path?",
    );
    questions.push(
      "What is the staging/local API base URL and auth scheme (Bearer / cookie)?",
    );
    return { steps: [], questions, notes };
  }

  const userCount = wantsUsers ? extractCount(prompt, 1) : 0;
  const steps: CreateDataStepPlan[] = [];

  for (let i = 0; i < userCount; i++) {
    const stepId = slugStep("create_user", i);
    steps.push({
      step_id: stepId,
      description: `Create user #${i + 1}`,
      method: "POST",
      endpoint: "/api/users",
      payload: {
        email: `seed.user${i + 1}@example.com`,
        name: `Seed User ${i + 1}`,
        password: "ChangeMe1!",
      },
      depends_on: [],
      rollback_endpoint: "/api/users/{{id}}",
    });
  }

  if (wantsOrders) {
    if (!wantsUsers) {
      questions.push(
        "Orders need a user_id — should we create users first, or reuse an existing user_id?",
      );
    }
    const perUserCompleted = wantsCompleted || (!wantsCompleted && !wantsPending);
    const perUserPending = wantsPending || (!wantsCompleted && !wantsPending);
    // If prompt mentions both statuses (common QC scenario), create both.
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
        description: `Create ${kind} order for user #${userIdx + 1}`,
        method: "POST",
        endpoint: "/api/orders",
        payload: {
          user_id: `{{${userStep}.id}}`,
          status: kind === "completed" ? "completed" : "pending",
          note: `Seed ${kind} order (batch)`,
        },
        depends_on: wantsUsers ? [userStep] : [],
        rollback_endpoint: "/api/orders/{{id}}",
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
      "Could not infer steps — name entities, counts, and desired statuses.",
    );
  } else {
    notes.push(
      "Default paths /api/users and /api/orders are placeholders — align with project routes before run.",
    );
  }

  return { steps, questions, notes };
}
