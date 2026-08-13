import { describe, expect, it } from "vitest";
import {
  docsReadySection,
  docsReadySummaryText,
  formatDocsReadyChatBody,
  parseDocsReadyPaths,
} from "../analysis.js";

const sample = `ANALYZED:
- Issue: admin đổi mật khẩu NV, bỏ OTP
- Đã đọc hub Staff + Email System
- Giả định: mail tới Staff.email, không notification

SUMMARY: Đã bổ sung doc feature admin đổi mật khẩu NV và cập nhật hub.

DOCS:
- docs/modules/organization/staff/admin-change-password.md
- docs/modules/organization/staff/README.md
`;

describe("docsReadySection", () => {
  it("extracts ANALYZED and SUMMARY", () => {
    expect(docsReadySection(sample, "ANALYZED")).toContain("bỏ OTP");
    expect(docsReadySection(sample, "SUMMARY")).toContain("admin đổi mật khẩu");
  });
});

describe("parseDocsReadyPaths", () => {
  it("collects docs paths", () => {
    expect(parseDocsReadyPaths(sample)).toEqual([
      "docs/modules/organization/staff/admin-change-password.md",
      "docs/modules/organization/staff/README.md",
    ]);
  });
});

describe("formatDocsReadyChatBody", () => {
  it("shows analysis + docs update + paths", () => {
    const body = formatDocsReadyChatBody(sample, parseDocsReadyPaths(sample));
    expect(body).toContain("### Đã phân tích");
    expect(body).toContain("bỏ OTP");
    expect(body).toContain("### Đã cập nhật docs");
    expect(body).toContain("### Paths");
    expect(body).toContain("admin-change-password.md");
  });
});

describe("docsReadySummaryText", () => {
  it("keeps analysis and summary without path dump", () => {
    const text = docsReadySummaryText(sample);
    expect(text).toContain("Đã phân tích");
    expect(text).toContain("Đã cập nhật docs");
    expect(text).not.toContain("admin-change-password.md");
  });
});
