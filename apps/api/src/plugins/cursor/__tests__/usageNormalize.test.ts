import { describe, expect, it } from "vitest";
import {
  normalizeUsageFields,
  pickUsageFromCandidates,
  maybeDeltaFromCumulative,
} from "../usageNormalize.js";

describe("normalizeUsageFields", () => {
  it("reads SDK camelCase usage and prefers chargedCents", () => {
    const n = normalizeUsageFields(
      {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 400,
        chargedCents: 12,
      },
      { usdPerMillionInput: 1.25, usdPerMillionOutput: 10 },
    );
    expect(n.fromSdk).toBe(true);
    expect(n.inputTokens).toBe(1000);
    expect(n.outputTokens).toBe(200);
    expect(n.cacheReadTokens).toBe(400);
    expect(n.costSource).toBe("sdk");
    expect(n.costCents).toBe(12);
    expect(n.chargedCents).toBe(12);
  });

  it("falls back to char/4 estimate when SDK omitted usage", () => {
    const n = normalizeUsageFields(null, {
      promptChars: 400,
      outputChars: 80,
      usdPerMillionInput: 1.25,
      usdPerMillionOutput: 10,
    });
    expect(n.fromSdk).toBe(false);
    expect(n.inputTokens).toBe(100);
    expect(n.outputTokens).toBe(20);
    expect(n.costSource).toBe("estimated");
    expect(n.costCents).toBeGreaterThanOrEqual(0);
  });

  it("treats small total_cost as USD", () => {
    const n = normalizeUsageFields(
      { input_tokens: 10, output_tokens: 5, total_cost: 0.42 },
      { usdPerMillionInput: 1.25, usdPerMillionOutput: 10 },
    );
    expect(n.chargedCents).toBe(42);
    expect(n.costSource).toBe("sdk");
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
});

describe("maybeDeltaFromCumulative", () => {
  it("subtracts prior agent totals when snapshot looks cumulative", () => {
    const current = normalizeUsageFields({
      inputTokens: 1500,
      outputTokens: 300,
      chargedCents: 20,
    });
    const delta = maybeDeltaFromCumulative(current, {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1200,
      costCents: 12,
      chargedCents: 12,
      estimatedCents: 12,
    });
    expect(delta.inputTokens).toBe(500);
    expect(delta.outputTokens).toBe(100);
    expect(delta.totalTokens).toBe(600);
    expect(delta.chargedCents).toBe(8);
    expect(delta.costSource).toBe("sdk");
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
      costCents: 12,
      chargedCents: 12,
      estimatedCents: 12,
    });
    expect(delta.inputTokens).toBe(80);
    expect(delta.totalTokens).toBe(90);
  });
});
