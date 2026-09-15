import { describe, expect, it } from "vitest";
import {
  assertPlanEntityAlignment,
  buildSeedPlan,
  extractEntityCount,
} from "../planner.js";
import {
  formatPlanQuestion,
  parseSeedPlanFromAgent,
} from "../parsePlan.js";
import {
  assertPlanPlaceholdersReferToSteps,
  assertSafeCreateDataTarget,
  assertSafeDbHost,
  assertSafeEnvironment,
  resolvePlaceholders,
} from "../executor.js";
import { normalizeCreateDataTargets } from "../../../workspace/baStore.js";

describe("extractEntityCount", () => {
  it("defaults to 1 when no count is stated", () => {
    expect(extractEntityCount("Tạo nhân viên mới tên An")).toBe(1);
    expect(extractEntityCount("Create a new staff for September 2026")).toBe(1);
  });

  it("reads count next to staff/user words only", () => {
    expect(extractEntityCount("Tạo 3 nhân viên")).toBe(3);
    expect(extractEntityCount("create 2 users")).toBe(2);
  });

  it("does not treat years as count", () => {
    expect(extractEntityCount("Tạo nhân viên tháng 9/2026")).toBe(1);
  });
});

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

  it("maps nhân viên to staffs (not users) and defaults to 1", () => {
    const plan = buildSeedPlan("Tạo nhân viên mới");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.collection).toBe("staffs");
    expect(plan.steps[0]?.op).toBe("insert");
  });

  it("asks questions when scenario is unclear", () => {
    const plan = buildSeedPlan("làm gì đó giúp mình");
    expect(plan.steps).toHaveLength(0);
    expect(plan.questions.length).toBeGreaterThan(0);
  });
});

describe("assertPlanEntityAlignment", () => {
  it("blocks users-only plan when scenario is staff", () => {
    const out = assertPlanEntityAlignment(
      "Tạo nhân viên mới",
      {
        steps: [
          {
            step_id: "u1",
            description: "user",
            op: "insert",
            collection: "users",
            data: { email: "a@b.c" },
            filter: null,
            depends_on: [],
          },
        ],
        questions: [],
        notes: [],
      },
    );
    expect(out.steps).toHaveLength(0);
    expect(out.questions.some((q) => /staffs/i.test(q))).toBe(true);
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

  it("rejects plans that invent fake placeholder steps", () => {
    expect(() =>
      assertPlanPlaceholdersReferToSteps([
        {
          step_id: "insert_staff_a",
          description: "staff",
          op: "insert",
          collection: "staffs",
          data: { country_id: "{{fk_catalog.country_id}}" },
          filter: null,
          depends_on: [],
        },
      ]),
    ).toThrow(/fk_catalog/);
  });

  it("accepts placeholders that point at earlier steps", () => {
    expect(() =>
      assertPlanPlaceholdersReferToSteps([
        {
          step_id: "insert_staff_a",
          description: "staff",
          op: "insert",
          collection: "staffs",
          data: { full_name: "A" },
          filter: null,
          depends_on: [],
        },
        {
          step_id: "insert_history_a",
          description: "history",
          op: "insert",
          collection: "staff_histories",
          data: { staff_id: "{{insert_staff_a._id}}" },
          filter: null,
          depends_on: ["insert_staff_a"],
        },
      ]),
    ).not.toThrow();
  });
});
