import { describe, expect, it } from "vitest";
import {
  formatPlanReadyChatBody,
  looksVietnamese,
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
  it("shows analysis + plan without rigid dual headings", () => {
    const body = formatPlanReadyChatBody(sample);
    expect(body).toContain("PLAN READY:");
    expect(body).toContain("nghỉ trưa");
    expect(body).toContain("Trừ giờ nghỉ trưa");
    expect(body).not.toContain("### Tóm tắt vấn đề");
    expect(body).not.toContain("### Cách giải quyết");
    expect(body).not.toContain("### Đã phân tích");
    expect(body).not.toContain("### Kế hoạch");
  });

  it("does not truncate long Vietnamese plan bodies", () => {
    const longPlan = `ANALYZED:\n${"Phân tích chi tiết vấn đề nghỉ trưa và phép bù. ".repeat(40)}\n\nPLAN:\n${"Bước sửa AttendanceService và duyệt phiếu gắn off_hours. ".repeat(40)}`;
    const body = formatPlanReadyChatBody(longPlan);
    expect(body.length).toBeGreaterThan(2000);
    expect(body).toContain("nghỉ trưa");
    expect(body).toContain("off_hours");
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
    expect(body).toContain("## Mục tiêu");
    expect(body).not.toMatch(/Đang xác nhận cách load ca$/m);
  });

  it("keeps substantial Vietnamese PLAN_READY over longer English createPlan", () => {
    const englishCreatePlan = [
      "## Overview",
      "Fix how shifts are loaded when recalculating used leave and attach off_hours on approval.",
      "",
      "## Scope",
      "- AttendanceService.loadShiftWhenRecalc",
      "- Approval flow flag off_hours",
      "",
      "## Steps",
      "1. Read the service",
      "2. Attach the flag",
      "3. Add regression tests covering both paths in detail with more English padding",
    ].join("\n");
    expect(pickPlanReadySource(sample, englishCreatePlan)).toBe(sample.trim());
    const body = formatPlanReadyChatBody(sample, { prose: englishCreatePlan });
    expect(body).toContain("nghỉ trưa");
    expect(body).toContain("Trừ giờ nghỉ trưa");
    expect(body).not.toContain("## Overview");
    expect(body).not.toContain("Fix how shifts are loaded");
  });

  it("does not swap English createPlan over shorter Vietnamese labeled body", () => {
    const vi = `ANALYZED:\nIssue liên quan load ca khi recalc used và duyệt phiếu off_hours.\n\nPLAN:\nSửa AttendanceService rồi gắn flag khi duyệt.`;
    const english = [
      "## Overview",
      "This is a much longer English createPlan body with many steps and details",
      "covering recalculation of used leave hours and approval flags.",
      "It intentionally exceeds the Vietnamese labeled sections in length.",
    ].join("\n");
    expect(looksVietnamese(vi)).toBe(true);
    expect(looksVietnamese(english)).toBe(false);
    const body = formatPlanReadyChatBody(vi, { prose: english });
    expect(body).toContain("recalc used");
    expect(body).toContain("AttendanceService");
    expect(body).not.toContain("## Overview");
    expect(body).not.toContain("intentionally exceeds");
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
  it("keeps analysis and plan without rigid labels", () => {
    const text = planReadySummaryText(sample);
    expect(text).toContain("nghỉ trưa");
    expect(text).toContain("Trừ giờ nghỉ trưa");
    expect(text).not.toContain("Tóm tắt vấn đề");
    expect(text).not.toContain("Cách giải quyết");
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

  it("prefers Vietnamese plain body over longer English createPlan", () => {
    const vi =
      "Phân tích: cần sửa load ca khi recalc used và gắn off_hours khi duyệt phiếu nghỉ. Cách làm: đọc AttendanceService, chỉnh công thức, thêm test.";
    const en = [
      "## Overview",
      "Fix shift loading when recalculating used leave and attach off_hours on approval.",
      "This English plan is intentionally longer with more padding words than the Vietnamese text.",
      "Steps include reading the service, changing the formula, and adding regression coverage.",
    ].join("\n");
    expect(pickPlanReadySource(en, vi)).toBe(vi);
  });
});
