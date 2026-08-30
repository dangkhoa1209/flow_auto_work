import { describe, expect, it } from "vitest";
import { workDurationMs } from "../workHours.js";

describe("workDurationMs", () => {
  it("counts same-day hours inside 08:30–17:30 VN", () => {
    // 09:00–10:00 ICT Friday
    const ms = workDurationMs(
      "2026-08-21T02:00:00.000Z",
      "2026-08-21T03:00:00.000Z",
    );
    expect(ms).toBe(60 * 60_000);
  });

  it("excludes nights and Sunday; Saturday still counts", () => {
    // Fri 17:00 ICT → Mon 09:00 ICT
    const ms = workDurationMs(
      "2026-08-21T10:00:00.000Z",
      "2026-08-24T02:00:00.000Z",
    );
    // Fri 30m + Sat 9h + Sun 0 + Mon 30m = 10h
    expect(ms).toBe(10 * 60 * 60_000);
  });

  it("returns null when end is missing or inverted", () => {
    expect(workDurationMs("2026-08-21T02:00:00.000Z", null)).toBeNull();
    expect(
      workDurationMs(
        "2026-08-21T03:00:00.000Z",
        "2026-08-21T02:00:00.000Z",
      ),
    ).toBeNull();
  });
});
