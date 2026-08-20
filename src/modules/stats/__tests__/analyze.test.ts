import { describe, expect, it } from "vitest";
import { classifyTaskType } from "../taskType.js";
import { computeDimensions } from "../scoring.js";

describe("classifyTaskType", () => {
  it("uses GitLab labels when present", () => {
    expect(classifyTaskType("Fix login", ["bug", "backend"])).toBe("bug");
    expect(classifyTaskType("Add chart", ["feature"])).toBe("feature");
  });

  it("defaults to feature when issue has no labels", () => {
    expect(classifyTaskType("Hotfix payment timeout", [])).toBe("feature");
    expect(classifyTaskType("Implement user dashboard", [])).toBe("feature");
  });

  it("defaults to feature when labels do not match mapping", () => {
    expect(classifyTaskType("Something", ["unrelated"])).toBe("feature");
  });

  it("respects custom admin mapping", () => {
    expect(
      classifyTaskType(
        "x",
        ["type::bug"],
        { bug: ["type::bug"], feature: [], refactor: [], chore: [] },
      ),
    ).toBe("bug");
  });
});

describe("computeDimensions", () => {
  it("returns accuracy from success rate", () => {
    const d = computeDimensions([
      {
        jobId: "1",
        issueIid: 1,
        title: "a",
        url: "",
        status: "succeeded",
        durationMs: 3600_000,
        tokensTotal: 10_000,
        runCount: 1,
        taskType: "feature",
      },
      {
        jobId: "2",
        issueIid: 2,
        title: "b",
        url: "",
        status: "failed",
        durationMs: 7200_000,
        tokensTotal: 20_000,
        runCount: 2,
        taskType: "bug",
        failReason: "Timeout",
      },
    ]);
    expect(d.accuracy).toBe(50);
  });
});
