import { describe, expect, it } from "vitest";
import {
  formatPlanReadyChatBody,
  pickPlanReadySource,
  planReadySection,
  planReadySectionsLen,
  planReadySummaryText,
} from "../planReady.js";

const sample = `ANALYZED:
- Issue: import nghỉ bù cả ca đang cộng giờ nghỉ trưa
- Neo: QualityAppraisal / phép bù đã dùng không phụ thuộc quỹ
- Giả định: chỉ sửa công thức giờ, không đổi UI

PLAN:
1. Tìm chỗ tính phép bù đã dùng
2. Trừ giờ nghỉ trưa khi cả ca
3. Thêm test case mẫu
`;

describe("planReadySection", () => {
  it("extracts ANALYZED and PLAN", () => {
    expect(planReadySection(sample, "ANALYZED")).toContain("nghỉ trưa");
    expect(planReadySection(sample, "PLAN")).toContain("Trừ giờ nghỉ trưa");
  });
});

describe("formatPlanReadyChatBody", () => {
  it("shows analysis + plan for the pair", () => {
    const body = formatPlanReadyChatBody(sample);
    expect(body).toContain("PLAN READY:");
    expect(body).toContain("### Đã phân tích");
    expect(body).toContain("nghỉ trưa");
    expect(body).toContain("### Kế hoạch");
    expect(body).toContain("Trừ giờ nghỉ trưa");
  });

  it("prefers long prose when PLAN section is a thin one-liner", () => {
    const thin = `PLAN: Đang xác nhận cách load ca khi recalc used`;
    const prose = [
      "Mục tiêu: sửa recalc used gắn off_hours",
      "Phạm vi: AttendanceService + phiếu duyệt",
      "Neo: loadShiftWhenRecalc, off_hours flag",
      "Bước: 1) đọc service 2) gắn flag 3) test",
    ].join("\n");
    const body = formatPlanReadyChatBody(thin, { prose });
    expect(body).toContain("PLAN READY:");
    expect(body).toContain("### Kế hoạch");
    expect(body).toContain("AttendanceService");
    expect(body).not.toMatch(/Đang xác nhận cách load ca$/m);
  });
});

describe("planReadySummaryText", () => {
  it("keeps analysis and plan", () => {
    const text = planReadySummaryText(sample);
    expect(text).toContain("Đã phân tích");
    expect(text).toContain("Kế hoạch");
  });
});

describe("pickPlanReadySource", () => {
  it("picks the candidate with richer PLAN sections", () => {
    const thin = "PLAN: Đang xác nhận load ca";
    expect(pickPlanReadySource(thin, sample)).toBe(sample.trim());
    expect(planReadySectionsLen(sample)).toBeGreaterThan(
      planReadySectionsLen(thin),
    );
  });

  it("falls back to longest plain text when no sections", () => {
    expect(pickPlanReadySource("short", "much longer plain plan text here")).toBe(
      "much longer plain plan text here",
    );
  });
});
