import { describe, expect, it } from "vitest";
import {
  normalizeIssueDraftForForm,
  parseIssueDraftFromAgent,
} from "../baThreadIssue.js";

describe("parseIssueDraftFromAgent", () => {
  it("parses JSON block from agent output", () => {
    const text = `## Tóm tắt
User muốn thêm validation.

\`\`\`json
{"title":"Login validation","description":"Add checks on form","labels":["feature"],"acceptanceCriteria":["Given valid user When login Then success"]}
\`\`\``;
    const draft = parseIssueDraftFromAgent(text);
    expect(draft).not.toBeNull();
    expect(draft!.title).toBe("Login validation");
    expect(draft!.labels).toEqual(["feature"]);
    expect(draft!.acceptanceCriteria).toHaveLength(1);
  });

  it("parses multiline JSON object with brace matching", () => {
    const text = `Summary here.

{"title":"Fix nút Lưu","description":"User báo nút Lưu không phản hồi trên màn hình chi tiết.","labels":["bug"],"acceptanceCriteria":["Given form hợp lệ When bấm Lưu Then lưu thành công"]}`;
    const draft = parseIssueDraftFromAgent(text);
    expect(draft?.title).toBe("Fix nút Lưu");
    expect(draft?.labels).toEqual(["bug"]);
  });

  it("falls back to markdown prose when JSON missing", () => {
    const text = `## Fix validation đăng nhập

User cần kiểm tra email trước khi submit.

- Given form trống When submit Then hiện lỗi`;
    const draft = parseIssueDraftFromAgent(text);
    expect(draft?.title).toContain("validation");
    expect(draft?.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(draft?.labels).toEqual([]);
  });

  it("returns null when title missing", () => {
    expect(parseIssueDraftFromAgent('{"description":"only desc"}')).toBeNull();
  });
});

describe("normalizeIssueDraftForForm", () => {
  it("merges AC into description and clears labels", () => {
    const out = normalizeIssueDraftForForm({
      title: "T",
      description: "Body",
      labels: ["feature"],
      acceptanceCriteria: ["Given A When B Then C"],
    });
    expect(out.labels).toEqual([]);
    expect(out.acceptanceCriteria).toEqual([]);
    expect(out.description).toContain("### Acceptance criteria");
    expect(out.description).toContain("Given A When B Then C");
  });
});
