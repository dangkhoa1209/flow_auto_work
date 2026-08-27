import { describe, expect, it } from "vitest";
import {
  buildThreadIssuePrompt,
  normalizeIssueDraftForForm,
  parseIssueDraftFromAgent,
  stripOpenQuestionsFromIssueDescription,
} from "../baThreadIssue.js";

describe("buildThreadIssuePrompt", () => {
  it("suggests spec format and excludes open questions from task", () => {
    const prompt = buildThreadIssuePrompt({
      displayName: "Demo",
      gitlabPath: "group/app",
      mainBranch: "main",
      threadBlock: "### Human\nphân tích export excel",
      gitlabTaskBlock: "",
      dbAccess: { allowed: false },
    });
    expect(prompt).toMatch(/gợi ý.*format spec/i);
    expect(prompt).toMatch(/đầu vào/);
    expect(prompt).toMatch(/phân tích BA/);
    expect(prompt).toMatch(/Tối thiểu: mục 1/);
    expect(prompt).toMatch(/KHÔNG đưa mục 4/);
    expect(prompt).toMatch(/Cấm ghi file/);
    expect(prompt).toMatch(/CHỈ ĐỌC/);
  });
});

describe("stripOpenQuestionsFromIssueDescription", () => {
  it("removes mục 4 open-questions section from task body", () => {
    const raw = `## 1. Yêu cầu khách hàng
Cần export Excel.

## 3. Nội dung phân tích
Cho phép xuất danh sách.

## 4. Câu hỏi cần xác nhận
- Có cần PDF không?

## Acceptance criteria
- Given danh sách When xuất Then tải file`;
    const cleaned = stripOpenQuestionsFromIssueDescription(raw);
    expect(cleaned).toContain("Yêu cầu khách hàng");
    expect(cleaned).toContain("Nội dung phân tích");
    expect(cleaned).toContain("Acceptance criteria");
    expect(cleaned).not.toMatch(/Câu hỏi cần xác nhận/);
    expect(cleaned).not.toContain("PDF");
  });
});

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

  it("strips open-questions section before form", () => {
    const out = normalizeIssueDraftForForm({
      title: "T",
      description:
        "## 1. Yêu cầu\nX\n\n## 4. Câu hỏi cần xác nhận\n- Còn hỏi?\n",
      labels: [],
      acceptanceCriteria: [],
    });
    expect(out.description).not.toMatch(/Câu hỏi cần xác nhận/);
    expect(out.description).toContain("Yêu cầu");
  });
});
