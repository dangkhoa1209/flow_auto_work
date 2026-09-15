import { describe, expect, it } from "vitest";
import {
  applySideEffectValidation,
  findMissingSideEffects,
} from "../knowledge/sideEffects.js";
import { detectCreateDataScope } from "../knowledge/scope.js";
import type { CreateDataStepPlan } from "../types.js";
import type {
  CreateDataKnowledgeDoc,
  CreateDataSideEffectEdge,
} from "../knowledge/types.js";

const edges: CreateDataSideEffectEdge[] = [
  {
    trigger_collection: "staffs",
    trigger_op: "insert",
    required_side_effects: [
      {
        target_collection: "staff_leaves",
        reason: "annual leave bootstrap",
        required: true,
        source_ref: "test",
        target_op: "insert",
      },
    ],
  },
];

function step(
  partial: Partial<CreateDataStepPlan> &
    Pick<CreateDataStepPlan, "step_id" | "op" | "collection">,
): CreateDataStepPlan {
  return {
    description: "",
    data: null,
    filter: null,
    depends_on: [],
    ...partial,
  };
}

describe("findMissingSideEffects", () => {
  it("flags insert staffs without staff_leaves", () => {
    const gaps = findMissingSideEffects(
      [step({ step_id: "a", op: "insert", collection: "staffs" })],
      edges,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.target_collection).toBe("staff_leaves");
  });

  it("passes when staff_leaves step present", () => {
    const gaps = findMissingSideEffects(
      [
        step({ step_id: "a", op: "insert", collection: "staffs" }),
        step({
          step_id: "b",
          op: "insert",
          collection: "staff_leaves",
          depends_on: ["a"],
        }),
      ],
      edges,
    );
    expect(gaps).toHaveLength(0);
  });
});

describe("applySideEffectValidation", () => {
  it("clears steps and adds questions when gaps exist", () => {
    const out = applySideEffectValidation(
      {
        steps: [step({ step_id: "a", op: "insert", collection: "staffs" })],
        questions: [],
        notes: [],
      },
      edges,
    );
    expect(out.steps).toHaveLength(0);
    expect(out.questions.length).toBeGreaterThan(0);
    expect(out.sideEffectGaps).toHaveLength(1);
  });
});

describe("detectCreateDataScope", () => {
  it("maps Vietnamese staff terms via fallback", () => {
    const r = detectCreateDataScope({
      texts: ["Tạo 2 nhân viên tên A và B"],
      knowledge: null,
    });
    expect(r.ambiguous).toBe(false);
    expect(r.collections.some((c) => /staff/i.test(c))).toBe(true);
  });

  it("uses glossary when present", () => {
    const knowledge = {
      id: "k",
      baProjectId: "p",
      sourceSha: null,
      status: "ready",
      rules: [],
      sideEffectEdges: [],
      glossary: [
        {
          term: "ca làm",
          aliases: ["shift"],
          collections: ["work_shifts"],
        },
      ],
      updatedAt: "",
      createdAt: "",
    } as CreateDataKnowledgeDoc;
    const r = detectCreateDataScope({
      texts: ["Seed ca làm cho tháng 9"],
      knowledge,
    });
    expect(r.collections).toContain("work_shifts");
  });
});
