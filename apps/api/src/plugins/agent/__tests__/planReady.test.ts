import { describe, expect, it } from "vitest";
import {
  formatPlanReadyChatBody,
  planReadySection,
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
});

describe("planReadySummaryText", () => {
  it("keeps analysis and plan", () => {
    const text = planReadySummaryText(sample);
    expect(text).toContain("Đã phân tích");
    expect(text).toContain("Kế hoạch");
  });
});
