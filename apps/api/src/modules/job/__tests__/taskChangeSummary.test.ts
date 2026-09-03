import { describe, expect, it } from "vitest";
import {
  buildTaskChangeText,
  classifyWorkOutcome,
  extractDoneSummaryLine,
  extractWorkHistoryFromChat,
  isWorkChatter,
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

  it("skips chat closers", () => {
    expect(
      extractDoneSummaryLine(
        "Đúng — #14832 đã xong trên branch foo (working tree sạch, đã commit).",
      ),
    ).toBe("");
  });
});

describe("isWorkChatter / classifyWorkOutcome", () => {
  it("flags confirmations as chatter", () => {
    expect(isWorkChatter("YC: done task rồi đúng ko")).toBe(true);
    expect(isWorkChatter("Đúng — #14832 đã xong trên branch x")).toBe(true);
  });

  it("buckets done vs not-done", () => {
    expect(classifyWorkOutcome("Đã bỏ hết enqueue/job tính lại phép")).toBe(
      "done",
    );
    expect(
      classifyWorkOutcome(
        "Không làm gì riêng cho phép năm khi Khóa/Mở khóa",
      ),
    ).toBe("not_done");
    expect(
      classifyWorkOutcome("Khóa/Mở khóa hiện không tính lại công — chỉ gán cờ close."),
    ).toBe("not_done");
  });
});

describe("extractWorkHistoryFromChat", () => {
  it("keeps agent outcomes and drops human YC lines", () => {
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
      { role: "user", body: "done task rồi đúng ko" },
      {
        role: "agent",
        body: "Đúng — #1 đã xong trên branch foo (working tree sạch).",
      },
    ]);
    expect(lines.some((l) => l.startsWith("YC:"))).toBe(false);
    expect(lines).toContain("Bỏ project bar trùng trên /ba mobile");
    expect(lines).toContain("Gộp AppTopbarRight — chỉ 1 nút theme");
    expect(lines.some((l) => /working tree|đúng —/i.test(l))).toBe(false);
  });
});

describe("buildTaskChangeText", () => {
  it("summarizes done / not-done without chat transcript or commit dump", () => {
    const text = buildTaskChangeText({
      jobSummary:
        "Đúng — #14832 đã xong trên branch foo (working tree sạch, đã commit).",
      workHistory: [
        "YC: bỏ enqueueRecalculateFromTimekeeping",
        "Đã bỏ hết enqueue/job tính lại phép khi công đổi.",
        "Đã siết lại gate trong Staff::created.",
        "Không làm gì riêng cho phép năm khi Khóa/Mở khóa — hook đã gỡ.",
        "Khóa/Mở khóa hiện không tính lại công — chỉ gán cờ close.",
      ],
      commitLines: [
        "5492ad24 — Merge branch 'project/ykk' into dangkhoa/ykk/staff_leave_features",
        "31dd3ece — feat #14832 ... (app/Models/Staff.php)",
      ],
      commitSubjects: ["feat #1 fix A", "feat #1 fix B"],
    });
    expect(text).toContain("**Đã làm**");
    expect(text).toContain("Đã bỏ hết enqueue/job tính lại phép khi công đổi.");
    expect(text).toContain("**Không làm**");
    expect(text).toContain("Không làm gì riêng cho phép năm khi Khóa/Mở khóa");
    expect(text).not.toContain("Lịch sử work task:");
    expect(text).not.toContain("YC:");
    expect(text).not.toContain("Commit (id → thay đổi):");
    expect(text).not.toContain("5492ad24");
    expect(text).not.toContain("Các commit trong task:");
    expect(text).not.toContain("working tree");
  });

  it("falls back to issue title when no work history", () => {
    const text = buildTaskChangeText({
      issueTitle: "Sửa login race",
      commitSubjects: [
        "feat #1 fix A",
        "feat #1 fix B",
        "feat #1 fix login race",
      ],
    });
    expect(text).toBe("Hoàn thành: Sửa login race");
    expect(text).not.toContain("feat #1 fix A");
  });

  it("keeps a real SUMMARY lead without commit noise", () => {
    const text = buildTaskChangeText({
      jobSummary: "SUMMARY: Chỉ một thay đổi",
      commitSubjects: ["feat #2 Chỉ một thay đổi"],
    });
    expect(text).toBe("Chỉ một thay đổi");
    expect(text).not.toContain("Các commit");
  });
});
