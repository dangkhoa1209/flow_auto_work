import { describe, expect, it } from "vitest";
import { classifyTaskType } from "../taskType.js";
import { computeDimensions } from "../scoring.js";
import { parseLlmAnalysisJson } from "../llmAnalyze.js";

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
        workDurationMs: 3600_000,
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
        workDurationMs: 7200_000,
        tokensTotal: 20_000,
        runCount: 2,
        taskType: "bug",
        failReason: "Timeout",
      },
    ]);
    expect(d.accuracy).toBe(50);
  });
});

describe("parseLlmAnalysisJson", () => {
  const jobs = [
    {
      jobId: "j1",
      issueIid: 12,
      title: "Fix pay",
      url: "https://example/12",
      status: "failed",
      durationMs: 1000,
      workDurationMs: 1000,
      tokensTotal: 10,
      runCount: 2,
      taskType: "bug",
    },
  ];

  it("parses nested dimension scores and title/detail recommendations", () => {
    const payload = {
      narrative: "Cần cải thiện độ chính xác.",
      dimensions: {
        speed: { score: 70, label: "Tốt", reasoning: "workMin ổn" },
        accuracy: { score: 40, label: "Yếu", reasoning: "fail cao" },
        scope: { score: 55, label: "TB", reasoning: "bug fail nhiều" },
        consistency: { score: 60, label: "TB", reasoning: "mẫu ít" },
        efficiency: { score: 80, label: "Tốt", reasoning: "token hợp lý" },
      },
      recommendations: [
        {
          title: "Giảm fail bug",
          detail: "Xem #12 — fail 50% trên bug",
          dimension: "chinhXac",
          severity: "high",
          evidenceJobIds: ["j1", "missing"],
        },
      ],
    };
    const raw = "```json\n" + JSON.stringify(payload) + "\n```";
    const parsed = parseLlmAnalysisJson(raw, jobs);
    expect(parsed?.narrative).toBe("Cần cải thiện độ chính xác.");
    expect(parsed?.dimensions?.accuracy).toBe(40);
    expect(parsed?.recommendations).toHaveLength(1);
    expect(parsed?.recommendations[0]?.dimension).toBe("accuracy");
    expect(parsed?.recommendations[0]?.text).toContain("Giảm fail bug");
    expect(parsed?.recommendations[0]?.evidenceJobs[0]?.issueIid).toBe(12);
  });

  it("accepts Vietnamese dimension aliases as flat numbers", () => {
    const payload = {
      narrative: "Ổn.",
      dimensions: {
        tocDo: 71,
        chinhXac: 72,
        phamVi: 73,
        nhatQuan: 74,
        hieuQua: 75,
      },
      recommendations: [],
    };
    const parsed = parseLlmAnalysisJson(JSON.stringify(payload), jobs);
    expect(parsed?.dimensions).toEqual({
      speed: 71,
      accuracy: 72,
      scope: 73,
      consistency: 74,
      efficiency: 75,
    });
  });

  it("returns null without narrative", () => {
    expect(parseLlmAnalysisJson('{"recommendations":[]}', jobs)).toBeNull();
  });
});
