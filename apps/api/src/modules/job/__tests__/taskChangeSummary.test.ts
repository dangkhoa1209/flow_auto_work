import { describe, expect, it } from "vitest";
import {
  buildTaskChangeText,
  extractDoneSummaryLine,
  extractWorkHistoryFromChat,
} from "../taskChangeSummary.js";

describe("extractDoneSummaryLine", () => {
  it("reads SUMMARY: from DONE body", () => {
    expect(
      extractDoneSummaryLine(
        "SUMMARY: Sửa header mobile\nASSUMPTIONS: không đổi desktop",
      ),
    ).toBe("Sửa header mobile");
  });

  it("falls back to first useful line", () => {
    expect(extractDoneSummaryLine("Đã bỏ project bar trùng\nRISKS: none")).toBe(
      "Đã bỏ project bar trùng",
    );
  });
});

describe("extractWorkHistoryFromChat", () => {
  it("pulls agent summaries and short human asks", () => {
    const lines = extractWorkHistoryFromChat([
      { role: "user", body: "bỏ project bar trùng mobile" },
      {
        role: "agent",
        body: "Đã bỏ bar.\n\nSUMMARY: Bỏ project bar trùng trên /ba mobile",
      },
      { role: "user", body: "sửa nút theme bị 2 cái" },
      {
        role: "agent",
        body: "SUMMARY: Gộp AppTopbarRight — chỉ 1 nút theme",
      },
    ]);
    expect(lines.some((l) => l.startsWith("YC:"))).toBe(true);
    expect(lines).toContain("Bỏ project bar trùng trên /ba mobile");
    expect(lines).toContain("Gộp AppTopbarRight — chỉ 1 nút theme");
  });
});

describe("buildTaskChangeText", () => {
  it("prefers work history + commit lines over branch commit dump", () => {
    const text = buildTaskChangeText({
      jobSummary: "SUMMARY: Sửa login race",
      workHistory: [
        "YC: login kẹt sau idle",
        "Sửa race clearAuth sau login",
      ],
      commitLines: [
        "a1b2c3d4 — fix auth race (apps/web/src/api/tokenStorage.ts)",
      ],
      commitSubjects: [
        "feat #1 fix A",
        "feat #1 fix B",
        "feat #1 fix login race",
      ],
    });
    expect(text).toContain("Sửa login race");
    expect(text).toContain("Lịch sử work task:");
    expect(text).toContain("YC: login kẹt sau idle");
    expect(text).toContain("Commit (id → thay đổi):");
    expect(text).toContain("a1b2c3d4 — fix auth race");
    expect(text).not.toContain("Các commit trong task:");
    expect(text).not.toContain("feat #1 fix A");
  });

  it("falls back to commit subjects when no work history", () => {
    const text = buildTaskChangeText({
      jobSummary: "SUMMARY: Sửa login race",
      commitSubjects: [
        "feat #1 fix A",
        "feat #1 fix B",
        "feat #1 fix login race",
      ],
    });
    expect(text).toContain("Các commit trong task:");
    expect(text).toContain("- feat #1 fix A");
    expect(text).toContain("Sửa login race");
  });

  it("keeps single-commit summary short", () => {
    const text = buildTaskChangeText({
      jobSummary: "SUMMARY: Chỉ một thay đổi",
      commitSubjects: ["feat #2 Chỉ một thay đổi"],
    });
    expect(text).toBe("Chỉ một thay đổi");
    expect(text).not.toContain("Các commit");
  });
});
