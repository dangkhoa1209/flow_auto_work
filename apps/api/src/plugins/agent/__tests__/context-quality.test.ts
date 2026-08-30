import { describe, expect, it } from "vitest";
import {
  assessContextQuality,
  resolveContextQualityForCoding,
} from "../context-quality.js";
import type { IssueJob } from "../../../types.js";

function makeIssue(overrides: Partial<IssueJob> = {}): IssueJob {
  return {
    projectId: 1,
    projectPath: "group/repo",
    issueIid: 42,
    issueId: 4200,
    title: "Task",
    description: "",
    labels: [],
    url: "https://gitlab.example.com/group/repo/-/issues/42",
    action: "open",
    ...overrides,
  };
}

describe("assessContextQuality", () => {
  it("bad: too-short vague description", () => {
    const res = assessContextQuality({
      issue: makeIssue({ title: "Sửa bug", description: "app bị lỗi" }),
    });
    expect(res.level).toBe("bad");
    expect(res.missing.length).toBeGreaterThan(0);
  });

  it("good: bug triad (repro + expected + file)", () => {
    const res = assessContextQuality({
      issue: makeIssue({
        title: "Lỗi lưu chấm công",
        description: [
          "Steps to reproduce:",
          "1. Mở /admin/attendance",
          "2. Bấm Lưu",
          "Current behavior: báo lỗi 500.",
          "Expected behavior: lưu thành công.",
          "File liên quan: AttendanceList.vue",
        ].join("\n"),
      }),
    });
    expect(res.level).toBe("good");
    expect(res.fileHints.join(",")).toContain("AttendanceList.vue");
  });

  it("good: clear technical Dev Notes alone", () => {
    const res = assessContextQuality({
      issue: makeIssue({ title: "Gia hạn hợp đồng", description: "" }),
      devNotes:
        "Thêm nút gia hạn hàng loạt ở ContractList.vue, gọi POST /api/contracts/bulk-renew với payload danh sách contract_id, backend xử lý trong ContractService, cập nhật collection contracts và trả response số bản ghi đã gia hạn.",
    });
    expect(res.level).toBe("good");
  });

  it("searchable: anchors (field/api) but no file", () => {
    const res = assessContextQuality({
      issue: makeIssue({
        title: "Cột lương cơ bản hiển thị sai",
        description:
          'Trên màn hình nhân viên, field base_salary hiển thị sai với nhân viên part-time, nút "Xuất Excel" cũng không tính cột này.',
      }),
    });
    expect(res.level).toBe("searchable");
    expect(res.anchors.length).toBeGreaterThan(0);
  });
});

describe("resolveContextQualityForCoding", () => {
  it("reuses sticky good mark without re-assessing", () => {
    const res = resolveContextQualityForCoding(
      {
        issue: makeIssue({ title: "x", description: "" }),
        contextQuality: {
          level: "good",
          assessedAt: new Date().toISOString(),
          anchors: ["/api/x"],
          fileHints: ["A.vue"],
        },
      },
      {},
    );
    expect(res.level).toBe("good");
    expect(res.cached).toBe(true);
    expect(res.fileHints).toEqual(["A.vue"]);
  });

  it("re-assesses when mark is not good", () => {
    const res = resolveContextQualityForCoding(
      {
        issue: makeIssue({ title: "Sửa bug", description: "bị lỗi" }),
        contextQuality: {
          level: "bad",
          assessedAt: new Date().toISOString(),
        },
      },
      { extraHuman: "vẫn lỗi" },
    );
    expect(res.cached).toBeFalsy();
    expect(res.level).toBe("bad");
  });
});
