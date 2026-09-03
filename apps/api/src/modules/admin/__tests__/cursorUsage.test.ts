import { describe, expect, it } from "vitest";
import { rollupCursorUsageEvents } from "../cursorUsage.js";
import type { CursorUsageEvent } from "../../../models/cursorUsage.js";

function ev(partial: Partial<CursorUsageEvent>): CursorUsageEvent {
  return {
    id: partial.id || "cue_1",
    userId: partial.userId || "alice",
    kind: partial.kind || "ba_chat",
    inputTokens: partial.inputTokens ?? 100,
    outputTokens: partial.outputTokens ?? 20,
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    cacheWriteTokens: partial.cacheWriteTokens ?? 0,
    totalTokens: partial.totalTokens ?? 120,
    chargedCents: partial.chargedCents ?? null,
    estimatedCents: partial.estimatedCents ?? 1,
    costCents: partial.costCents ?? 1,
    costSource: partial.costSource ?? "estimated",
    fromSdk: partial.fromSdk ?? false,
    createdAt: partial.createdAt || "2026-09-04T03:00:00.000Z",
  };
}

describe("rollupCursorUsageEvents", () => {
  it("groups by user, kind, and ICT day", () => {
    const rows = [
      ev({
        userId: "alice",
        kind: "ba_chat",
        totalTokens: 100,
        costCents: 10,
        createdAt: "2026-09-03T17:00:00.000Z",
      }),
      ev({
        id: "cue_2",
        userId: "alice",
        kind: "ba_create_issue",
        totalTokens: 50,
        costCents: 5,
        createdAt: "2026-09-04T02:00:00.000Z",
      }),
      ev({
        id: "cue_3",
        userId: "bob",
        kind: "job_run",
        totalTokens: 200,
        costCents: 40,
        costSource: "sdk",
        chargedCents: 40,
        createdAt: "2026-09-04T10:00:00.000Z",
      }),
    ];
    const r = rollupCursorUsageEvents(rows, "2026-09-04", "2026-09-04");
    expect(r.totals.events).toBe(3);
    expect(r.totals.totalTokens).toBe(350);
    expect(r.totals.costCents).toBe(55);
    expect(r.byUser[0].userId).toBe("bob");
    expect(r.byUser.find((u) => u.userId === "alice")?.events).toBe(2);
    expect(r.byKind.map((k) => k.kind).sort()).toEqual(
      ["ba_chat", "ba_create_issue", "job_run"].sort(),
    );
    const day = r.byDay.find((d) => d.date === "2026-09-04");
    expect(day?.events).toBe(3);
  });
});
