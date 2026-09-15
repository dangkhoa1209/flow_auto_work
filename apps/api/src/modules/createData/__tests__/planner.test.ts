import { describe, expect, it } from "vitest";
import { buildSeedPlan } from "../planner.js";
import {
  formatPlanQuestion,
  parseSeedPlanFromAgent,
} from "../parsePlan.js";
import {
  assertSafeCreateDataTarget,
  assertSafeDbHost,
  assertSafeEnvironment,
  resolvePlaceholders,
} from "../executor.js";
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
      plan.steps.filter((s) => s.collection === "orders"),
    ).toHaveLength(4);
    const order = plan.steps.find((s) => s.step_id.startsWith("create_order_"));
    expect(order?.data?.user_id).toMatch(/\{\{create_user_\d+\.id\}\}/);
    expect(order?.op).toBe("insert");
  });

  it("asks questions when scenario is unclear", () => {
    const plan = buildSeedPlan("làm gì đó giúp mình");
    expect(plan.steps).toHaveLength(0);
    expect(plan.questions.length).toBeGreaterThan(0);
  });
});

describe("parseSeedPlanFromAgent", () => {
  it("parses fenced JSON DB plan", () => {
    const text = `Tóm tắt plan.

\`\`\`json
{
  "steps": [
    {
      "step_id": "create_staff_1",
      "description": "Insert staff",
      "op": "insert",
      "collection": "staff",
      "data": { "code": "NV01" },
      "filter": null,
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
    expect(plan?.steps[0]?.collection).toBe("staff");
    expect(plan?.steps[0]?.op).toBe("insert");
    expect(plan?.notes).toContain("from source");
  });

  it("formats {field, reason} questions instead of [object Object]", () => {
    const text = `\`\`\`json
{
  "steps": [],
  "questions": [
    {
      "field": "cccd",
      "reason": "phải đủ 12 số (nhận 33333)"
    }
  ],
  "notes": ["validation failed"]
}
\`\`\``;
    const plan = parseSeedPlanFromAgent(text);
    expect(plan?.steps).toHaveLength(0);
    expect(plan?.questions).toEqual([
      "cccd: phải đủ 12 số (nhận 33333)",
    ]);
  });

  it("rejects legacy HTTP plans", () => {
    const text = `\`\`\`json
{
  "steps": [
    {
      "step_id": "create_staff_1",
      "method": "POST",
      "endpoint": "/api/v1/staff",
      "payload": { "code": "NV01" },
      "depends_on": []
    }
  ],
  "questions": [],
  "notes": []
}
\`\`\``;
    const plan = parseSeedPlanFromAgent(text);
    expect(plan).toBeNull();
  });
});

describe("formatPlanQuestion", () => {
  it("keeps plain strings", () => {
    expect(formatPlanQuestion("Which table?")).toBe("Which table?");
  });

  it("joins field + reason", () => {
    expect(
      formatPlanQuestion({ field: "email", reason: "required" }),
    ).toBe("email: required");
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

  it("blocks production-looking DB host", () => {
    expect(() => assertSafeDbHost("db.prod.internal")).toThrow(/production/i);
  });

  it("blocks production-looking SSH bastion", () => {
    expect(() =>
      assertSafeCreateDataTarget({
        dialect: "mysql",
        host: "localhost",
        port: 3306,
        database: "app",
        username: "u",
        password: "p",
        ssl: false,
        ssh: {
          enabled: true,
          sshHost: "bastion.prod.internal",
          sshPort: 22,
          sshUsername: "ops",
          sshPassword: "x",
          sshPrivateKey: "",
          tunnelLocalPort: 13306,
        },
      }),
    ).toThrow(/production/i);
  });

  it("resolves step placeholders", () => {
    const out = resolvePlaceholders(
      { user_id: "{{create_user_1.id}}" },
      { create_user_1: { id: "u99" } },
    ) as { user_id: string };
    expect(out.user_id).toBe("u99");
  });
});
