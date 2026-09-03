import { describe, expect, it } from "vitest";
import {
  buildTaskChangeText,
  extractDoneSummaryLine,
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

describe("buildTaskChangeText", () => {
  it("lists all commits when task has many", () => {
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
    expect(text).toContain("- feat #1 fix B");
    expect(text).toContain("- feat #1 fix login race");
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
