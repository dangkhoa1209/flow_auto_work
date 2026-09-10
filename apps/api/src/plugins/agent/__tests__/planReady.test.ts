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
    expect(body).toContain("### Tóm tắt vấn đề");
    expect(body).toContain("nghỉ trưa");
    expect(body).toContain("### Cách giải quyết");
    expect(body).toContain("Trừ giờ nghỉ trưa");
  });

  it("prefers long createPlan body over thin PLAN_READY one-liner", () => {
    const thin = "PLAN: Đang xác nhận cách load ca khi recalc used";
    const createPlan = [
      "## Mục tiêu",
      "Sửa recalc used gắn off_hours khi duyệt phiếu",
      "",
      "## Phạm vi",
      "- AttendanceService.loadShiftWhenRecalc",
      "- Chỗ duyệt phiếu gắn flag off_hours",
      "",
      "## Bước",
      "1. Đọc service",
      "2. Gắn flag",
      "3. Test",
    ].join("\n");
    expect(pickPlanReadySource(thin, createPlan)).toBe(createPlan);
    const body = formatPlanReadyChatBody(thin, { prose: createPlan });
    expect(body).toContain("AttendanceService");
    expect(body).toContain("### Cách giải quyết");
    expect(body).not.toMatch(/Đang xác nhận cách load ca$/m);
  });

  it("does not let thin PLAN label inside a long stream beat a full plan", () => {
    const stream = [
      "Đang đọc AttendanceService…",
      "Tìm loadShiftWhenRecalc và off_hours",
      "PLAN: Đang xác nhận load ca",
    ].join("\n\n");
    const createPlan = [
      "Mục tiêu: full plan",
      "Phạm vi: A + B",
      "Bước: 1 2 3",
      "Neo: loadShiftWhenRecalc + off_hours",
      "Rủi ro: thấp",
    ].join("\n");
    expect(pickPlanReadySource("PLAN: ngắn", stream, createPlan)).toBe(
      createPlan,
    );
  });
});

describe("planReadySummaryText", () => {
  it("keeps analysis and plan", () => {
    const text = planReadySummaryText(sample);
    expect(text).toContain("Tóm tắt vấn đề");
    expect(text).toContain("Cách giải quyết");
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
