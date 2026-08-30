import { describe, expect, it } from "vitest";
import { enumerateDays, isoWeekFromYmd, shiftYmd } from "../calendar.js";
import { classifyFailReason, pctChange, successRate } from "../metrics.js";
import { buildMonthTree, finishDayBucket } from "../tree.js";

describe("stats metrics", () => {
  it("computes success rate from terminal jobs only", () => {
    expect(successRate(8, 2)).toBe(80);
    expect(successRate(0, 0)).toBeNull();
  });

  it("computes period-over-period pct", () => {
    expect(pctChange(118, 100)).toBe(18);
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(10, 0)).toBeNull();
  });

  it("classifies fail reasons", () => {
    expect(classifyFailReason("Force stop by user")).toBe("Force stop");
    expect(classifyFailReason("")).toBe("(no reason)");
  });
});

describe("stats tree", () => {
  it("rolls month → week → day with token totals", () => {
    const d1 = finishDayBucket({
      date: "2026-08-20",
      jobCount: 2,
      awaitingHandoff: 1,
      succeeded: 1,
      failed: 0,
      runningLike: 0,
      tokensTotal: 1000,
      tokensInput: 400,
      tokensOutput: 600,
      items: [
        {
          jobId: "a",
          status: "succeeded",
          issueIid: 1,
          title: "t",
          url: "",
          at: "2026-08-20T10:00:00.000Z",
          tokensTotal: 1000,
          tokensInput: 400,
          tokensOutput: 600,
          durationMs: 120_000,
        },
      ],
    });
    const months = buildMonthTree([d1]);
    expect(months).toHaveLength(1);
    expect(months[0]!.monthKey).toBe("2026-08");
    expect(months[0]!.tokensTotal).toBe(1000);
    expect(months[0]!.succeeded).toBe(1);
    expect(months[0]!.weeks[0]!.days[0]!.date).toBe("2026-08-20");
    expect(isoWeekFromYmd("2026-08-20").week).toBe(34);
  });
});

describe("calendar", () => {
  it("enumerates inclusive days", () => {
    expect(enumerateDays("2026-08-19", "2026-08-20")).toEqual([
      "2026-08-19",
      "2026-08-20",
    ]);
    expect(shiftYmd("2026-08-20", -1)).toBe("2026-08-19");
  });
});
