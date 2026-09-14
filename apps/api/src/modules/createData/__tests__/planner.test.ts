import { describe, expect, it } from "vitest";
import { buildSeedPlan } from "../planner.js";
import { parseSeedPlanFromAgent } from "../parsePlan.js";
import { assertSafeEnvironment, resolvePlaceholders } from "../executor.js";
import { normalizeCreateDataTargets } from "../../../workspace/baStore.js";

describe("buildSeedPlan", () => {
  it("builds users + completed/pending orders from VN prompt", () => {
    const plan = buildSeedPlan(
      "Tạo 2 user, mỗi user có 1 đơn hoàn thành và 1 đơn pending",
    );
    expect(plan.questions).toHaveLength(0);
    expect(plan.steps.some((s) => s.step_id === "create_user_1")).toBe(true);
    expect(plan.steps.some((s) => s.step_id === "create_user_2")).toBe(true);
    expect(
      plan.steps.filter((s) => s.endpoint === "/api/orders"),
    ).toHaveLength(4);
    const order = plan.steps.find((s) => s.step_id.startsWith("create_order_"));
    expect(order?.payload?.user_id).toMatch(/\{\{create_user_\d+\.id\}\}/);
    expect(order?.method).toBe("POST");
  });

  it("asks questions when scenario is unclear", () => {
    const plan = buildSeedPlan("làm gì đó giúp mình");
    expect(plan.steps).toHaveLength(0);
    expect(plan.questions.length).toBeGreaterThan(0);
  });
});

describe("parseSeedPlanFromAgent", () => {
  it("parses fenced JSON plan", () => {
    const text = `Tóm tắt plan.

\`\`\`json
{
  "steps": [
    {
      "step_id": "create_staff_1",
      "description": "Create staff",
      "method": "POST",
      "endpoint": "/api/v1/staff",
      "payload": { "code": "NV01" },
      "depends_on": []
    }
  ],
  "questions": [],
  "notes": ["from source"]
}
\`\`\`
`;
    const plan = parseSeedPlanFromAgent(text);
    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0]?.endpoint).toBe("/api/v1/staff");
    expect(plan?.notes).toContain("from source");
  });
});

describe("normalizeCreateDataTargets", () => {
  it("keeps one URL per env and drops production", () => {
    const targets = normalizeCreateDataTargets([
      { environment: "staging", apiBaseUrl: "https://stg.example/" },
      { environment: "staging", apiBaseUrl: "https://dup.example" },
      { environment: "production", apiBaseUrl: "https://prod.example" },
      { environment: "local", apiBaseUrl: "http://localhost:3000" },
    ]);
    expect(targets).toEqual([
      { environment: "staging", apiBaseUrl: "https://stg.example" },
      { environment: "local", apiBaseUrl: "http://localhost:3000" },
    ]);
  });
});

describe("executor guards", () => {
  it("blocks production environment", () => {
    expect(() => assertSafeEnvironment("production")).toThrow(/Production/i);
  });

  it("resolves step placeholders", () => {
    const out = resolvePlaceholders(
      { user_id: "{{create_user_1.id}}" },
      { create_user_1: { id: "u99" } },
    ) as { user_id: string };
    expect(out.user_id).toBe("u99");
  });
});
