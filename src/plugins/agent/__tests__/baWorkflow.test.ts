import { describe, expect, it } from "vitest";
import {
  looksLikeGreetingOrNoise,
  parseResultUpdateFromChat,
  parseTaskFromWorkflowOutput,
  parseTasksFromBreakdown,
  parseWorkflowStepGate,
  stripResultUpdateBlock,
} from "../baWorkflow.js";
import { parseTaskFromChatContent } from "../../../modules/baWorkbench/index.js";

describe("parseWorkflowStepGate", () => {
  it("keeps blocked only when clarify is thin (no real analysis)", () => {
    const text = `YC chưa đủ.

\`\`\`json
{"gate":"blocked","openQuestions":["Ai là owner module X?"]}
\`\`\``;
    const gate = parseWorkflowStepGate("clarify", text);
    expect(gate.status).toBe("blocked");
    expect(gate.openQuestions).toContain("Ai là owner module X?");
  });

  it("softens blocked→ok when clarify already has IN/OUT analysis", () => {
    const text = `## Tóm tắt yêu cầu
Khách cần quản lý giấy phép lái xe của tài xế trên OSS, một nhân viên có nhiều giấy phép.

## Phạm vi
### IN Scope
- Quản lý GPLX gắn nhân viên, CRUD cơ bản, lưu để tra cứu nội bộ.

### OUT Scope
- Quản lý xe / phân công tài xế.

## Giả định & câu hỏi mở
- Giả định: đặt trong nhóm quản lý nhân viên.
### Cần chốt sau (không chặn phân tích)
- Có cần cảnh báo hết hạn không?

YC đủ nền tảng để sang Hiện trạng.

\`\`\`json
{"gate":"blocked","openQuestions":["Có cần cảnh báo hết hạn?"]}
\`\`\``;
    const gate = parseWorkflowStepGate("clarify", text);
    expect(gate.status).toBe("ok");
    expect(gate.openQuestions[0]).toContain("cảnh báo");
  });

  it("markdown 'Cần chốt sau' does not block the flow", () => {
    const text = `## Tóm tắt yêu cầu
Quản lý GPLX cho tài xế.

## Phạm vi
### IN Scope
- Lưu nhiều GPLX / nhân viên.

### OUT Scope
- App tài xế.

### Cần chốt sau (không chặn phân tích)
- Cảnh báo hết hạn?`;
    const gate = parseWorkflowStepGate("clarify", text);
    expect(gate.status).toBe("ok");
  });

  it("invalid when clarify says input is not a requirement", () => {
    const text = `Chào bạn! Nội dung chưa phải yêu cầu.

\`\`\`json
{"gate":"invalid","openQuestions":["Nhập yêu cầu thật: ai cần gì, để làm gì"]}
\`\`\``;
    const gate = parseWorkflowStepGate("clarify", text);
    expect(gate.status).toBe("invalid");
    expect(gate.openQuestions[0]).toContain("ai cần gì");
  });

  it("invalid gate without reasons gets default reason", () => {
    const text = `\`\`\`json
{"gate":"invalid","openQuestions":[]}
\`\`\``;
    const gate = parseWorkflowStepGate("clarify", text);
    expect(gate.status).toBe("invalid");
    expect(gate.openQuestions.length).toBeGreaterThan(0);
  });

  it("ok for non-clarify steps", () => {
    expect(parseWorkflowStepGate("asIs", "anything").status).toBe("ok");
  });
});

describe("looksLikeGreetingOrNoise", () => {
  it.each(["hi", "Hello", "xin chào", "chào bạn", "alo alo", "test", "123", "…", "👋"])(
    "flags %j as noise",
    (raw) => {
      expect(looksLikeGreetingOrNoise(raw)).toBe(true);
    },
  );

  it.each([
    "Khách muốn thêm nút xuất Excel ở màn hình danh sách đơn hàng",
    "PD yêu cầu: user quên mật khẩu phải nhận được email reset trong 5 phút",
  ])("accepts real requirement %j", (raw) => {
    expect(looksLikeGreetingOrNoise(raw)).toBe(false);
  });
});

describe("parseResultUpdateFromChat", () => {
  const answer = `Đã bổ sung phạm vi xuất PDF theo yêu cầu.

\`\`\`json
{"resultUpdate":{"title":"Xuất báo cáo đơn hàng","description":"Cho phép xuất Excel và PDF","acceptanceCriteria":["Given màn hình đơn hàng When bấm Xuất Then tải file"],"devNotes":"Tận dụng cơ chế xuất hiện có"}}
\`\`\``;

  it("parses resultUpdate block", () => {
    const update = parseResultUpdateFromChat(answer);
    expect(update?.title).toBe("Xuất báo cáo đơn hàng");
    expect(update?.description).toContain("PDF");
    expect(update?.acceptanceCriteria).toHaveLength(1);
    expect(update?.devNotes).toContain("Tận dụng");
  });

  it("returns null when no update block", () => {
    expect(parseResultUpdateFromChat("Chỉ trả lời hỏi đáp bình thường")).toBeNull();
  });

  it("strips block from display content", () => {
    const cleaned = stripResultUpdateBlock(answer);
    expect(cleaned).toContain("Đã bổ sung phạm vi xuất PDF");
    expect(cleaned).not.toContain("resultUpdate");
  });
});

describe("parseTaskFromWorkflowOutput", () => {
  it("parses single task JSON", () => {
    const text = `## Task
\`\`\`json
{"task":{"title":"YC login","description":"Full scope","labels":[],"acceptanceCriteria":[]}}
\`\`\``;
    const task = parseTaskFromWorkflowOutput(text);
    expect(task?.title).toBe("YC login");
    expect(task?.devNotes).toBe("");
  });

  it("parses devNotes riêng cho Dev", () => {
    const text = `\`\`\`json
{"task":{"title":"YC login","description":"Nghiệp vụ thuần","labels":[],"acceptanceCriteria":[],"devNotes":"Liên quan luồng đăng nhập hiện có"}}
\`\`\``;
    const task = parseTaskFromWorkflowOutput(text);
    expect(task?.devNotes).toBe("Liên quan luồng đăng nhập hiện có");
    expect(task?.description).toBe("Nghiệp vụ thuần");
  });

  it("falls back to first item in legacy tasks array", () => {
    const text = `\`\`\`json
{"tasks":[{"title":"Only one","description":"x","labels":[],"acceptanceCriteria":[]},{"title":"Ignored","description":"y","labels":[],"acceptanceCriteria":[]}]}
\`\`\``;
    const tasks = parseTasksFromBreakdown(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Only one");
  });
});

describe("parseTasksFromBreakdown", () => {
  it("parses JSON block from breakdown output", () => {
    const text = `## Tasks
Task A mô tả

\`\`\`json
{"tasks":[{"title":"Login validation","description":"Add checks","labels":["feature"],"acceptanceCriteria":["Given valid user When login Then success"]}]}
\`\`\``;
    const tasks = parseTasksFromBreakdown(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Login validation");
    expect(tasks[0].labels).toEqual(["feature"]);
  });
});

describe("parseTaskFromChatContent", () => {
  it("extracts title line from chat draft", () => {
    const parsed = parseTaskFromChatContent(
      "**Tiêu đề:** Fix nút Lưu\n\nMô tả chi tiết…",
    );
    expect(parsed.title).toBe("Fix nút Lưu");
    expect(parsed.description).toContain("Mô tả chi tiết");
  });
});
