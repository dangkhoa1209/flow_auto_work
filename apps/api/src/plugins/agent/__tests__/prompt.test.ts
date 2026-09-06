import { describe, expect, it } from "vitest";
import {
  buildWorkPrompt,
  commitMessageForIssue,
  docsCommitMessageForIssue,
  extractChatBodyFromAgentText,
  parseAgentOutcome,
  shortCommitSubject,
} from "../prompt.js";

const issue = {
  projectId: 1,
  projectPath: "group/app",
  issueIid: 102,
  issueId: 102,
  title: "Big table",
  description: "Show all rows",
  labels: ["frontend"],
  url: "https://example/issues/102",
  action: "manual",
};

describe("commitMessageForIssue", () => {
  it("uses feat + iid + short subject from whatDone", () => {
    const msg = commitMessageForIssue(issue, {
      whatDone:
        "SUMMARY: đã sửa SSE resync và auto-retry khi Cursor cắt stream\nASSUMPTIONS: give-up 3 phút",
    });
    expect(msg).toBe(
      "feat #102 đã sửa SSE resync và auto-retry khi Cursor cắt stream",
    );
  });

  it("falls back to truncated issue title", () => {
    const long = {
      ...issue,
      title:
        "một hai ba bốn năm sáu bảy tám chín mười mườimột mườihai title rất dài",
    };
    expect(commitMessageForIssue(long)).toBe(
      "feat #102 một hai ba bốn năm sáu bảy tám chín mười",
    );
  });

  it("omits iid for adhoc", () => {
    const adhoc = { ...issue, issueIid: 0, action: "adhoc", title: "free fix" };
    expect(commitMessageForIssue(adhoc)).toBe("feat free fix");
  });

  it("docs prefix mirrors feat rules", () => {
    expect(
      docsCommitMessageForIssue(issue, { whatDone: "cập nhật docs feature X" }),
    ).toBe("docs #102 cập nhật docs feature X");
  });
});

describe("shortCommitSubject", () => {
  it("caps at 10 words", () => {
    expect(
      shortCommitSubject("a b c d e f g h i j k l m"),
    ).toBe("a b c d e f g h i j");
  });
});

describe("parseAgentOutcome", () => {
  it("parses DONE block", () => {
    const out = parseAgentOutcome(
      "some prose\n<<<DONE>>>\nSUMMARY: đã sửa xong\n<<<END_DONE>>>",
    );
    expect(out.kind).toBe("done");
    expect(out.summary).toContain("đã sửa xong");
  });

  it("parses NEED_CLARIFICATION block (wins over DONE)", () => {
    const out = parseAgentOutcome(
      "<<<NEED_CLARIFICATION>>>\n1. Chọn màn hình nào?\n<<<END_NEED_CLARIFICATION>>>\n<<<DONE>>>x<<<END_DONE>>>",
    );
    expect(out.kind).toBe("need_clarification");
    expect(out.question).toContain("màn hình nào");
  });

  it("parses DOCS_READY block", () => {
    const out = parseAgentOutcome(
      "<<<DOCS_READY>>>\nPATHS:\n- docs/feature.md\n<<<END_DOCS_READY>>>",
    );
    expect(out.kind).toBe("docs_ready");
    expect(out.summary).toContain("docs/feature.md");
  });

  it("parses PLAN_READY block", () => {
    const out = parseAgentOutcome(
      "<<<PLAN_READY>>>\nPLAN: sửa LoginForm.vue\n<<<END_PLAN_READY>>>",
    );
    expect(out.kind).toBe("plan_ready");
    expect(out.summary).toContain("LoginForm");
  });

  it("falls back to loose NEED_CLARIFICATION:", () => {
    const out = parseAgentOutcome("NEED_CLARIFICATION: cái nào đúng?");
    expect(out.kind).toBe("need_clarification");
    expect(out.question).toBe("cái nào đúng?");
  });

  it("returns unknown with tail summary when no tags", () => {
    const out = parseAgentOutcome("just some text without markers");
    expect(out.kind).toBe("unknown");
    expect(out.summary).toBe("just some text without markers");
  });
});

describe("extractChatBodyFromAgentText", () => {
  const longAnalysis = [
    "## Phân tích task",
    "- Mục tiêu: gia hạn hợp đồng hàng loạt theo loại kế tiếp",
    "- Neo code: ContractService.php, EmployeeList.vue",
    "- Rủi ro: migration dữ liệu cũ",
    "- Bước tiếp: xác nhận rule chuyển loại",
  ].join("\n");

  it("prefers full prose over short DONE summary", () => {
    const text = `${longAnalysis}\n\n<<<DONE>>>\nSUMMARY: đã phân tích\n<<<END_DONE>>>`;
    const body = extractChatBodyFromAgentText(text, {
      summary: "đã phân tích",
    });
    expect(body).toContain("Phân tích task");
    expect(body).toContain("Rủi ro");
    expect(body).not.toContain("<<<DONE>>>");
  });

  it("falls back to summary when prose is empty", () => {
    const text = "<<<DONE>>>\nSUMMARY: chỉ có dòng này\n<<<END_DONE>>>";
    const body = extractChatBodyFromAgentText(text, {
      summary: "chỉ có dòng này",
    });
    expect(body).toBe("chỉ có dòng này");
  });

  it("falls back to question when only clarification tag exists", () => {
    const text =
      "<<<NEED_CLARIFICATION>>>\n1. A hay B?\n<<<END_NEED_CLARIFICATION>>>";
    const body = extractChatBodyFromAgentText(text, { question: "1. A hay B?" });
    expect(body).toBe("1. A hay B?");
  });

  it("strips GITLAB_COMMENT blocks from body", () => {
    const text = `${longAnalysis}\n<<<GITLAB_COMMENT>>>\nsecret gitlab body\n<<<END_GITLAB_COMMENT>>>`;
    const body = extractChatBodyFromAgentText(text);
    expect(body).not.toContain("secret gitlab body");
    expect(body).toContain("Mục tiêu");
  });

  it("returns (no reply) for empty input", () => {
    expect(extractChatBodyFromAgentText("")).toBe("(no reply)");
  });
});

describe("buildWorkPrompt graphify", () => {
  it("injects how-to-use graphify instructions", () => {
    const prompt = buildWorkPrompt(issue, undefined, undefined, undefined, {
      graphifyBlock:
        "## How to use Graphify (code map)\ncall code_map_query with a short locator",
    });
    expect(prompt).toMatch(/code_map_query/);
    expect(prompt).toContain("How to use Graphify");
    expect(prompt).toMatch(/Investigate via \*\*code_map_query\*\* first/);
  });

  it("omits the map when no graphify block is passed", () => {
    const prompt = buildWorkPrompt(issue);
    expect(prompt).not.toContain("How to use Graphify");
  });
});
