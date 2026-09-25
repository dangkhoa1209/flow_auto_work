import { describe, expect, it } from "vitest";
import {
  normalizeUsageFields,
  pickUsageFromCandidates,
  maybeDeltaFromCumulative,
} from "../usageNormalize.js";

describe("normalizeUsageFields", () => {
  it("reads SDK camelCase usage tokens", () => {
    const n = normalizeUsageFields({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 400,
    });
    expect(n.fromSdk).toBe(true);
    expect(n.inputTokens).toBe(1000);
    expect(n.outputTokens).toBe(200);
    expect(n.cacheReadTokens).toBe(400);
  });

  it("falls back to char/4 estimate when SDK omitted usage", () => {
    const n = normalizeUsageFields(null, {
      promptChars: 400,
      outputChars: 80,
    });
    expect(n.fromSdk).toBe(false);
    expect(n.inputTokens).toBe(100);
    expect(n.outputTokens).toBe(20);
  });
});

describe("pickUsageFromCandidates", () => {
  it("unwraps nested .usage", () => {
    const picked = pickUsageFromCandidates(
      { status: "ok" },
      { usage: { inputTokens: 50, outputTokens: 10 } },
    );
    expect(picked?.inputTokens).toBe(50);
  });

  it("reads token usage from AgentUsage shape", () => {
    const picked = pickUsageFromCandidates({
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      cost: { rawCostCents: 5, chargedCents: 3 },
      runs: [],
    });
    expect(picked?.inputTokens).toBe(100);
  });
});

describe("maybeDeltaFromCumulative", () => {
  it("subtracts prior agent totals when snapshot looks cumulative", () => {
    const current = normalizeUsageFields({
      inputTokens: 1500,
      outputTokens: 300,
    });
    const delta = maybeDeltaFromCumulative(current, {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1200,
    });
    expect(delta.inputTokens).toBe(500);
    expect(delta.outputTokens).toBe(100);
    expect(delta.totalTokens).toBe(600);
  });

  it("keeps per-run usage when snapshot is smaller than prior sum", () => {
    const current = normalizeUsageFields({
      inputTokens: 80,
      outputTokens: 10,
    });
    const delta = maybeDeltaFromCumulative(current, {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1200,
    });
    expect(delta.inputTokens).toBe(80);
    expect(delta.totalTokens).toBe(90);
  });
});
