import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "@cursor/sdk";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import {
  getBaProject,
  getBaProjectGitlabToken,
  getBaThread,
  listBaMessages,
  resolveSystemCursorApiKey,
  resolveSystemCursorModel,
  resolveSystemCursorModelSpec,
  type BaMessage,
} from "../../workspace/baStore.js";
import { readOnlyAgentPolicy } from "../cursor/agentPolicy.js";
import { loadBaLinkedContext } from "../ba/ba-linked-context.js";
import { resolveBaUserGoogleAccessToken } from "../../modules/google/index.js";
import {
  beginCancellableJob,
  errorFromCursorRunStatus,
  isTransientCursorTransportError,
} from "./run.js";
import { persistCursorUsage } from "../cursor/recordUsage.js";

const ISSUE_DRAFT_TIMEOUT_MS = 10 * 60 * 1000;

/** Empty cwd so the draft agent cannot browse customer source. */
async function issueDraftScratchCwd(): Promise<string> {
  const dir = path.join(tmpdir(), "flow-ba-issue-draft");
  await mkdir(dir, { recursive: true });
  return dir;
}

export type BaThreadIssueDraft = {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
};

/**
 * Bỏ mục 4 "Câu hỏi cần xác nhận" khỏi mô tả task — chỉ dùng khi chat/phân tích,
 * không đưa lên GitLab issue.
 */
export function stripOpenQuestionsFromIssueDescription(
  description: string,
): string {
  const lines = description.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (
      /^#{1,3}\s*4[\.\)]?\s*Câu hỏi cần xác nhận/i.test(t) ||
      /^#{1,3}\s*Câu hỏi cần xác nhận/i.test(t)
    ) {
      skipping = true;
      continue;
    }
    if (skipping && /^#{1,3}\s+\S/.test(t)) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Nhật ký tiến độ / meta — không thay cho nội dung phân tích. */
const ISSUE_META_NARRATION_SOURCE =
  String.raw`đã\s+(?:tổng\s+hợp|mô\s+tả|tìm\s+hiểu|soạn(?:\s+lại)?|phân\s+tích(?:\s+xong)?)|bản\s+chốt\s+cuối|không\s+đưa\s+(?:case|req)|tóm\s+tắt\s+hội\s+thoại|đã\s+soạn\s+(?:lại\s+)?(?:issue|task|draft)|xem\s+(?:lại\s+)?(?:phân\s+tích|chat|hội\s+thoại|bên\s+trên)|như\s+(?:đã\s+)?(?:nêu|mô\s+tả|trên)|gap\s+.+\s*↔`;

function issueMetaNarrationRe(flags = "i"): RegExp {
  return new RegExp(ISSUE_META_NARRATION_SOURCE, flags);
}

function hasBaIssueHeadings(text: string): boolean {
  return (
    /#{1,3}\s*1[\.\)]?\s*Yêu cầu/i.test(text) ||
    /#{1,3}\s*3[\.\)]?\s*Nội dung phân tích/i.test(text) ||
    /#{1,3}\s*3\.1[\.\)]?\s*Màn hình/i.test(text) ||
    /#{1,3}\s*3\.2[\.\)]?\s*Logic xử lý/i.test(text)
  );
}

/**
 * Có chi tiết phân tích thật (3.1/3.2, bảng, hoặc thân mục 3 đủ dài
 * sau khi bỏ câu meta).
 */
export function hasIssueAnalysisSubstance(description: string): boolean {
  const t = description.trim();
  if (!t) return false;
  if (/#{1,3}\s*3\.[12]/i.test(t)) return true;
  const pipeCount = (t.match(/\|/g) || []).length;
  if (pipeCount >= 8) return true;
  const section3 =
    /#{1,3}\s*3[\.\)]?\s*Nội dung phân tích[^\n]*\n([\s\S]*?)(?=#{1,3}\s+\S|$)/i.exec(
      t,
    );
  if (section3) {
    const body = section3[1]
      .replace(issueMetaNarrationRe("gi"), "")
      .replace(/#{1,6}\s+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (body.length >= 120) return true;
  }
  const withoutMeta = t
    .replace(issueMetaNarrationRe("gi"), "")
    .replace(/#{1,6}\s+[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return withoutMeta.length >= 400;
}

/**
 * Description chưa đủ nội dung phân tích mục 1–3 (thiếu đầu mục BA,
 * chỉ nhật ký meta, hoặc quá ngắn so với bản phân tích trong chat).
 */
export function isThinIssueDescription(description: string): boolean {
  const t = description.trim();
  if (!t) return true;
  const hasBaHeadings = hasBaIssueHeadings(t);
  const substance = hasIssueAnalysisSubstance(t);
  const metaHit = issueMetaNarrationRe("i").test(t);

  if (hasBaHeadings && substance && t.length >= 200) return false;
  if (metaHit && !substance) return true;
  if (!hasBaHeadings && t.length < 500) return true;
  if (hasBaHeadings && !substance) return true;
  return false;
}

/**
 * Khi description chưa đủ: thay bằng bản phân tích chat (đã bỏ mục 4)
 * nếu dài/hữu ích hơn.
 */
export function enrichIssueDraftWithLatestAnalysis(
  draft: BaThreadIssueDraft,
  latestAnalysis: string | null | undefined,
): BaThreadIssueDraft {
  if (!isThinIssueDescription(draft.description)) return draft;
  const analysis = (latestAnalysis || "").trim();
  if (!analysis) return draft;
  const cleaned = stripOpenQuestionsFromIssueDescription(analysis);
  if (!cleaned) return draft;
  const draftThin = isThinIssueDescription(draft.description);
  const cleanedBetter =
    !isThinIssueDescription(cleaned) ||
    cleaned.length > draft.description.trim().length;
  if (draftThin && cleanedBetter) {
    return { ...draft, description: cleaned };
  }
  return draft;
}

/** Bỏ JSON issue draft khỏi prose agent (để enrich từ phần chữ ngoài JSON). */
export function stripIssueDraftJsonFromAgentText(text: string): string {
  let out = text.replace(/```(?:json|JSON)?\s*[\s\S]*?```/g, "");
  for (const obj of extractJsonObjectsWithTitle(text)) {
    out = out.split(obj).join("");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Chọn bản agent text giàu description hơn giữa stream SSE và result.wait()
 * (tránh lần tạo ngắn ngủn khi một phía truncated / meta).
 */
export function pickBestIssueAgentText(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;

  const draftL = parseIssueDraftFromAgent(left);
  const draftR = parseIssueDraftFromAgent(right);
  if (draftL && draftR) {
    const thinL = isThinIssueDescription(draftL.description);
    const thinR = isThinIssueDescription(draftR.description);
    if (thinL !== thinR) return thinL ? right : left;
    if (draftR.description.length !== draftL.description.length) {
      return draftR.description.length > draftL.description.length
        ? right
        : left;
    }
  } else if (draftL && !draftR) {
    return left;
  } else if (!draftL && draftR) {
    return right;
  }
  return left.length >= right.length ? left : right;
}

/** Gộp AC vào mô tả; không gán label mặc định cho form. */
export function normalizeIssueDraftForForm(
  draft: BaThreadIssueDraft,
): BaThreadIssueDraft {
  let description = stripOpenQuestionsFromIssueDescription(
    draft.description.trim(),
  );
  const ac = draft.acceptanceCriteria.map((s) => s.trim()).filter(Boolean);
  if (ac.length && !/###\s*Acceptance criteria/i.test(description)) {
    const parts = [
      description,
      "### Acceptance criteria",
      ...ac.map((line) => `- ${line}`),
    ].filter(Boolean);
    description = parts.join("\n\n");
  }
  return {
    title: draft.title,
    description,
    labels: [],
    acceptanceCriteria: [],
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function extractAssistantText(message: {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
}): string {
  if (message.type !== "assistant") return "";
  let text = "";
  for (const block of message.message?.content || []) {
    if (block.type === "text" && block.text) text += block.text;
  }
  return text;
}

function formatThreadBlock(messages: BaMessage[]): string {
  return messages
    .filter((m) => m.content?.trim())
    .map((m) => {
      const who = m.role === "user" ? "Human" : "Assistant";
      return `### ${who}\n${m.content.trim()}`;
    })
    .join("\n\n");
}

/** Assistant message gần nhất trông như bản phân tích / spec BA (ưu tiên khi soạn issue). */
export function findLatestBaAnalysisMessage(
  messages: BaMessage[],
): BaMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.content?.trim()) continue;
    const c = m.content;
    if (
      /#{1,3}\s*3[\.\)]?\s*Nội dung phân tích/i.test(c) ||
      /#{1,3}\s*1[\.\)]?\s*Yêu cầu khách hàng/i.test(c) ||
      /#{1,3}\s*3\.1[\.\)]?\s*Màn hình/i.test(c)
    ) {
      return m;
    }
  }
  return null;
}

function formatLatestAnalysisBlock(messages: BaMessage[]): string {
  const latest = findLatestBaAnalysisMessage(messages);
  if (!latest?.content?.trim()) return "";
  return `## Phân tích BA mới nhất trong hội thoại (ƯU TIÊN — đưa vào field description)
Đây là bản phân tích **gần nhất** trong chat. **Yêu cầu:** \`description\` phải mang **đầy đủ nội dung** mục 1–3 (logic/cột/điều kiện/màn hình đã chốt, gần nguyên văn, **bỏ mục 4**) — không thay bằng câu nhật ký kiểu "đã mô tả", "đã tìm hiểu", "đã tổng hợp theo chat".
Các lượt Human/Assistant **sau** khối này (nếu có trong "Hội thoại cần review") phải được **gộp vào** description; không đóng băng bản cũ.

${latest.content.trim()}`;
}

function preferRicherIssueDraft(
  a: BaThreadIssueDraft,
  b: BaThreadIssueDraft,
): BaThreadIssueDraft {
  const thinA = isThinIssueDescription(a.description);
  const thinB = isThinIssueDescription(b.description);
  if (thinA !== thinB) return thinA ? b : a;
  return b.description.length > a.description.length ? b : a;
}

/** Parse single issue JSON from agent output (tolerant + markdown fallback). */
export function parseIssueDraftFromAgent(text: string): BaThreadIssueDraft | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: BaThreadIssueDraft[] = [];
  const pushParsed = (raw: string) => {
    const repaired = repairJsonLoose(raw);
    const parsed =
      tryParseIssueJson(repaired) || tryExtractIssueFieldsLoose(repaired);
    if (parsed) candidates.push(parsed);
  };

  for (const block of allCodeFenceBlocks(trimmed)) {
    pushParsed(block);
  }

  for (const obj of extractJsonObjectsWithTitle(trimmed)) {
    pushParsed(obj);
  }

  // Whole text may be raw JSON / fence-less object with broken escapes.
  if (!candidates.length) {
    pushParsed(trimmed);
  }

  if (candidates.length) {
    return candidates.reduce((best, cur) => preferRicherIssueDraft(best, cur));
  }

  return fallbackIssueDraftFromProse(trimmed);
}

/**
 * Khi agent JSON hỏng hoàn toàn: dựng draft từ bản phân tích BA gần nhất trong chat.
 */
export function draftFromLatestBaAnalysis(
  messages: BaMessage[],
): BaThreadIssueDraft | null {
  const latest = findLatestBaAnalysisMessage(messages);
  if (!latest?.content?.trim()) return null;
  const description = stripOpenQuestionsFromIssueDescription(
    latest.content.trim(),
  );
  if (!description || description.length < 40) return null;

  const title = titleFromBaAnalysis(description);
  if (!title) return null;
  return {
    title: title.slice(0, 200),
    description,
    labels: [],
    acceptanceCriteria: [],
  };
}

function titleFromBaAnalysis(description: string): string {
  const s1 = /#{1,3}\s*1[\.\)]?\s*Yêu cầu[^\n]*\n([\s\S]*?)(?=#{1,3}\s+\S|$)/i.exec(
    description,
  );
  if (s1) {
    const body = s1[1]
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (body.length >= 8) return body.slice(0, 120);
  }
  const heading = /^#{1,3}\s+(.+)$/m.exec(description);
  if (heading) {
    const h = heading[1]
      .replace(/^\d+[\.\)]\s*/, "")
      .replace(/^Yêu cầu khách hàng\s*[-–:]?\s*/i, "")
      .trim();
    if (h && !/^Nội dung phân tích/i.test(h)) return h.slice(0, 120);
  }
  const first = description
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^#{1,6}\s/.test(l));
  return (first || "Task từ hội thoại BA").replace(/\*\*/g, "").slice(0, 120);
}

function allCodeFenceBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const block = m[1]?.trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

function extractJsonObjectsWithTitle(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start < 0) break;
    const window = text.slice(start, start + 800);
    if (!/"title"\s*:/.test(window)) {
      i = start + 1;
      continue;
    }
    const slice = extractBalancedJson(text, start);
    if (slice) {
      out.push(slice);
      i = start + slice.length;
    } else {
      i = start + 1;
    }
  }
  return out;
}

function extractBalancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function repairJsonLoose(raw: string): string {
  return escapeRawControlsInJsonStrings(
    raw
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/,\s*([}\]])/g, "$1"),
  );
}

/** LLM thường nhét markdown đa dòng vào JSON mà không escape \\n / \\t. */
function escapeRawControlsInJsonStrings(raw: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escape) {
        out += c;
        escape = false;
        continue;
      }
      if (c === "\\") {
        out += c;
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        out += c;
        continue;
      }
      if (c === "\n") {
        out += "\\n";
        continue;
      }
      if (c === "\r") {
        out += "\\r";
        continue;
      }
      if (c === "\t") {
        out += "\\t";
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inString = true;
    out += c;
  }
  return out;
}

/**
 * Khi JSON.parse vẫn fail (vd. dấu " trong description không escape):
 * lấy title/description theo field name + marker kết thúc.
 */
function tryExtractIssueFieldsLoose(raw: string): BaThreadIssueDraft | null {
  const title = matchJsonStringField(raw, "title");
  if (!title?.trim()) return null;
  const description = matchJsonStringField(raw, "description") || "";
  return {
    title: title.trim().slice(0, 200),
    description: description.trim(),
    labels: [],
    acceptanceCriteria: [],
  };
}

function matchJsonStringField(raw: string, field: string): string | null {
  const startRe = new RegExp(`"${field}"\\s*:\\s*"`);
  const m = startRe.exec(raw);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = raw.slice(start);

  if (field === "description") {
    const endM =
      /"\s*,\s*"(?:labels|acceptanceCriteria)"|"\s*\}\s*$|"\s*\}/.exec(rest);
    if (endM && endM.index > 0) {
      return unescapeJsonStringFragment(rest.slice(0, endM.index));
    }
  }

  let out = "";
  let escape = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') return unescapeJsonStringFragment(out);
    out += c;
  }
  return out ? unescapeJsonStringFragment(out) : null;
}

function unescapeJsonStringFragment(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function inferIssueLabel(_text: string): string[] {
  return [];
}

function fallbackIssueDraftFromProse(text: string): BaThreadIssueDraft | null {
  // Keep fence bodies that failed JSON parse — often still usable as markdown.
  const body = text.trim();
  if (!body) return null;
  if (/^\{[\s\S]*\}$/.test(body) && !/"title"\s*:/.test(body)) return null;

  // Full BA analysis as prose (common when agent ignores JSON-only instruction).
  if (hasBaIssueHeadings(body) && hasIssueAnalysisSubstance(body)) {
    const cleaned = stripOpenQuestionsFromIssueDescription(
      body.replace(/```(?:json|JSON)?\s*/gi, "").replace(/```/g, ""),
    );
    const title = titleFromBaAnalysis(cleaned);
    if (title) {
      return {
        title: title.slice(0, 200),
        description: cleaned,
        labels: [],
        acceptanceCriteria: [],
      };
    }
  }

  const withoutFences = body.replace(/```[\s\S]*?```/g, "").trim();
  const prose = withoutFences || body;
  if (!prose) return null;

  let title = "";
  const descLines: string[] = [];
  const ac: string[] = [];

  for (const line of prose.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (trimmedLine.startsWith("{") && trimmedLine.endsWith("}")) continue;

    const titleLine =
      /^(?:#\s+|##\s+)(.+)/.exec(trimmedLine) ||
      /(?:\*\*)?(?:Title|Tiêu đề)(?:\*\*)?\s*:+\s*(.+)/i.exec(
        trimmedLine.replace(/^\*+|\*+$/g, ""),
      );
    if (titleLine && !title) {
      title = titleLine[1].replace(/^\*+|\*+$/g, "").trim();
      continue;
    }

    if (
      /^[-*]\s*(?:AC|Given|When|Then)/i.test(trimmedLine) ||
      /^Given\s/i.test(trimmedLine)
    ) {
      ac.push(trimmedLine.replace(/^[-*]\s*/, "").trim());
      continue;
    }

    if (/^#{1,6}\s/.test(trimmedLine)) continue;
    descLines.push(line);
  }

  if (!title) {
    title =
      descLines.find((l) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 120) ||
      "";
  }
  if (!title) return null;

  const description = descLines.join("\n").trim();
  return {
    title: title.slice(0, 200),
    description,
    labels: inferIssueLabel(`${title}\n${description}`),
    acceptanceCriteria: ac,
  };
}

function tryParseIssueJson(raw: string): BaThreadIssueDraft | null {
  try {
    const parsed = JSON.parse(raw) as {
      title?: string;
      description?: string;
      labels?: string[];
      acceptanceCriteria?: string[];
    };
    const title = String(parsed.title || "").trim();
    if (!title) return null;
    return {
      title: title.slice(0, 200),
      description: String(parsed.description || "").trim(),
      labels: (parsed.labels || []).map((l) => String(l).trim()).filter(Boolean),
      acceptanceCriteria: (parsed.acceptanceCriteria || [])
        .map((s) => String(s).trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

export function buildThreadIssuePrompt(opts: {
  displayName: string;
  gitlabPath: string;
  threadBlock: string;
  gitlabTaskBlock: string;
  latestAnalysisBlock?: string;
}): string {
  const inputBlocks = [
    opts.gitlabTaskBlock?.trim(),
    opts.latestAnalysisBlock?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

  return `Bạn là Business Analyst trên dự án **${opts.displayName}**.

## Vai trò & Nhiệm vụ
Khi người dùng bấm **Create issue**, nhiệm vụ của bạn là: **Chỉ tổng hợp từ nội dung hội thoại được cung cấp** để tạo ra **MỘT** bản draft GitLab issue hoàn chỉnh cho Dev/QA.
- Phải phản ánh **trạng thái đã chốt sau cùng** trong trao đổi (ưu tiên các trao đổi/sửa đổi ở lượt chat cuối).
- Tuyệt đối không đọc source code, không gọi tool, không truy vấn database, không suy diễn thông tin ngoài hội thoại.

---

## Nguyên tắc ngôn ngữ & Nghiệp vụ
- **100% văn phong nghiệp vụ:** Diễn đạt theo góc nhìn người dùng/BA (tên màn hình, tên nút, luồng thao tác, quy tắc kiểm tra theo UI tiếng Việt).
- **Tuyệt đối không nhắc yếu tố kỹ thuật:** Không đề cập tên file, hàm, class, biến, bảng/cột DB, endpoint API, framework hay câu lệnh truy vấn trong phần mô tả.
- **Không suy diễn giao diện ngoài thực tế:** Chỉ mô tả cấu trúc giao diện theo thông tin đã chốt. Không tự bịa kích thước pixel, mã màu, mockup hoặc yêu cầu người dùng gửi ảnh chụp màn hình.

---

## Cấu trúc Description (Format chuẩn BA)

Trình bày nội dung \`description\` bằng định dạng Markdown GFM theo đúng các tiêu đề chuẩn dưới đây (chỉ đưa vào các mục có dữ liệu):

### 1. Yêu cầu khách hàng
- Nêu ngắn gọn (1–3 câu) nhu cầu nghiệp vụ gốc từ khách hàng hoặc người dùng.
- **In đậm** tên danh mục / chức năng chính. Giữ nguyên ý nghiệp vụ gốc, không chèn kết luận hay giải pháp của BA vào mục này.

### 2. Yêu cầu/Đề xuất từ PD *(Bỏ qua nếu hội thoại không có ý kiến của PD)*
- Tóm tắt đề xuất/giải pháp ở mức màn hình hoặc phân hệ từ Product Designer / Product Owner (Ví dụ: Bổ sung màn hình X tại phân hệ A > B).

### 3. Nội dung phân tích
- **Màn hình xử lý:** Ghi rõ đường dẫn menu đầy đủ (Ví dụ: \`Admin > C&B > Hợp đồng\`) và URL hệ thống (nếu có).

#### 3.1. Màn hình [Tên màn hình] *(Nếu có giao diện danh sách)*
- Mô tả bố cục màn hình và thanh công cụ (các nút chức năng phía trên: Thêm mới, Bộ lọc, Xuất file... theo thực tế chốt).
- **Bảng danh sách:** Dùng bảng Markdown chuẩn:
  | STT | Tên trường | Mô tả | Kiểu control |
  | --- | --- | --- | --- |
- **Mục con chi tiết cột (3.1.x. Cột [Tên cột]):** Chỉ mô tả sâu cho những cột có logic đặc biệt (định dạng hiển thị, cơ chế lọc, copy, menu thao tác).

#### 3.2. Logic xử lý
Tách rõ từng thao tác nghiệp vụ đã thống nhất (Thêm mới, Cập nhật, Xóa, Phê duyệt, Khóa/Mở khóa, Import/Export...):
- **Điều kiện:** Ràng buộc, trạng thái dữ liệu cho phép thực hiện.
- **Thực hiện:** Trình tự xử lý, popup xác nhận, cập nhật trạng thái/thời gian, thông báo thành công.
- **Lưu ý:** Quy tắc chặn, thông báo lỗi và xử lý ngoại lệ.

#### 3.3. Popup "[Tên popup]" *(Nếu có thao tác mở form/popup)*
- Điều kiện mở popup và danh sách các trường thông tin:
  | STT | Tên trường | Mô tả | Kiểu control | Bắt buộc (Y/N) |
  | --- | --- | --- | --- | --- |
- Quy tắc kiểm tra tính hợp lệ (validate), quy tắc sinh mã tự động (nếu có) và hành vi của các nút hành động (Lưu, Hủy, Đóng).

> **LƯU Ý QUAN TRỌNG VỀ MỤC 4:**
> **KHÔNG đưa mục "4. Câu hỏi cần xác nhận" vào issue description.** Tất cả các điểm đã trao đổi, làm rõ hoặc được chốt trong hội thoại phải được tổng hợp thẳng vào Mục 1, 2 hoặc 3.

---

## Dữ liệu đầu vào

${inputBlocks ? `${inputBlocks}\n\n` : ""}## Hội thoại cần review (Đọc toàn bộ — Ưu tiên kết quả chốt sau cùng)
${opts.threadBlock}

---

## Định dạng đầu ra (BẮT BUỘC)
Chỉ trả về **DUY NHẤT một khối JSON hợp lệ** theo cấu trúc dưới đây, không kèm bất kỳ lời mở đầu, giải thích hay kết luận nào ngoài khối code:

\`\`\`json
{
  "title": "[Tên ngắn gọn, rõ ràng của tính năng/chức năng chính đã chốt]",
  "description": "[Toàn bộ nội dung mô tả bằng Markdown theo đúng cấu trúc Mục 1, 2, 3 ở trên]",
  "labels": [],
  "acceptanceCriteria": []
}
\`\`\``;
}

/**
 * Draft a GitLab issue from the BA chat thread only.
 * No git pull, graphify, DB, or customer source — the agent runs on an empty cwd.
 */
export async function runBaThreadIssueDraft(opts: {
  threadId: string;
  baProjectId: string;
  onProgress?: (label: string, step?: string) => void;
}): Promise<BaThreadIssueDraft> {
  const cancelKey = `ba-issue:${opts.threadId}`;
  const session = beginCancellableJob(cancelKey);
  const progress = (label: string, step?: string) => {
    try {
      opts.onProgress?.(label, step);
    } catch {
      /* ignore */
    }
  };

  try {
    const project = await getBaProject(opts.baProjectId);
    if (!project) throw new Error("BA project not found");

    const messages = await listBaMessages(opts.threadId);
    const threadBlock = formatThreadBlock(messages);
    if (!threadBlock.trim()) {
      throw new Error("No conversation to summarize into an issue");
    }
    const latestAnalysisBlock = formatLatestAnalysisBlock(messages);

    session.check();
    const apiKey = await resolveSystemCursorApiKey();
    const model = await resolveSystemCursorModelSpec();

    const userTexts = messages
      .filter((m) => m.role === "user" && m.content?.trim())
      .slice(-8)
      .map((m) => m.content.trim());
    const gitlabToken = await getBaProjectGitlabToken(project.id);
    const thread = await getBaThread(opts.threadId);
    const googleAccessToken = thread?.userId
      ? await resolveBaUserGoogleAccessToken(thread.userId)
      : null;
    const linked = await loadBaLinkedContext({
      gitlabHost: project.gitlabHost,
      gitlabPath: project.gitlabPath,
      gitlabToken,
      googleAccessToken,
      texts: userTexts,
    });
    session.check();

    const prompt = buildThreadIssuePrompt({
      displayName: project.displayName,
      gitlabPath: project.gitlabPath,
      threadBlock,
      gitlabTaskBlock: linked.block,
      latestAnalysisBlock,
    });

    logger.info("BA thread issue draft starting", {
      threadId: opts.threadId,
      projectId: opts.baProjectId,
      messageCount: messages.length,
    });

    progress("Drafting issue from chat…", "agent");

    const work = async (): Promise<BaThreadIssueDraft> => {
      session.check();
      const scratchCwd = await issueDraftScratchCwd();
      const agent = await Agent.create({
        apiKey,
        model,
        ...readOnlyAgentPolicy(),
        mcpServers: {},
        local: {
          cwd: scratchCwd,
          settingSources: [],
        },
      });

      await using disposed = agent;
      session.check();
      const run = await disposed.send(prompt);
      session.attach(run);

      let streamed = "";
      try {
        if (
          typeof run.stream === "function" &&
          run.supports?.("stream") !== false
        ) {
          for await (const message of run.stream()) {
            session.check();
            const chunk = extractAssistantText(
              message as {
                type?: string;
                message?: {
                  content?: Array<{ type?: string; text?: string }>;
                };
              },
            );
            if (!chunk) continue;
            // Snapshot vs delta (same as BA chat) — tránh nhân đôi / mất đuôi JSON dài.
            if (chunk.startsWith(streamed) && chunk.length >= streamed.length) {
              streamed = chunk;
            } else if (streamed && streamed.endsWith(chunk)) {
              /* duplicate trailing snapshot */
            } else {
              streamed += chunk;
            }
          }
        }
      } catch (err) {
        if (!isTransientCursorTransportError(err)) {
          logger.warn("BA thread issue stream error; waiting for result", {
            err: String(err),
          });
        }
      }

      session.check();
      const result = await run.wait();
      if (result.status === "error") {
        throw errorFromCursorRunStatus(
          result as {
            id: string;
            result?: string;
            durationMs?: number;
            errorCode?: string;
            requestId?: string;
          },
          { label: "BA issue draft" },
        );
      }

      const fromResult = String(
        (result as { result?: string }).result || "",
      ).trim();
      const finalText = pickBestIssueAgentText(fromResult, streamed);
      if (!finalText) throw new Error("Agent returned empty content");
      if (
        fromResult &&
        streamed &&
        fromResult !== streamed &&
        finalText === streamed &&
        fromResult.length >= streamed.length
      ) {
        logger.info("BA thread issue draft preferred stream over longer result", {
          threadId: opts.threadId,
          resultChars: fromResult.length,
          streamChars: streamed.length,
        });
      }

      await persistCursorUsage({
        kind: "ba_create_issue",
        userId: thread?.userId,
        threadId: opts.threadId,
        agent: disposed,
        run,
        result,
        promptChars: prompt.length,
        outputChars: finalText.length,
        model: await resolveSystemCursorModel(),
      });

      let parsed = parseIssueDraftFromAgent(finalText);
      if (!parsed) {
        parsed = draftFromLatestBaAnalysis(messages);
        if (parsed) {
          logger.warn("BA thread issue draft recovered from chat analysis", {
            threadId: opts.threadId,
            preview: finalText.slice(0, 400),
            length: finalText.length,
            title: parsed.title.slice(0, 80),
          });
        }
      }
      if (!parsed) {
        logger.warn("BA thread issue draft parse failed", {
          threadId: opts.threadId,
          preview: finalText.slice(0, 600),
          length: finalText.length,
        });
        throw new AppError(
          "Agent did not return valid issue JSON — add more detail in chat and try again",
          422,
          "ba_issue_draft_parse_failed",
        );
      }
      const latestAnalysis =
        findLatestBaAnalysisMessage(messages)?.content || "";
      let enriched = enrichIssueDraftWithLatestAnalysis(
        parsed,
        latestAnalysis,
      );
      // Cùng lượt: agent có thể viết spec đầy đủ ngoài JSON mỏng.
      if (isThinIssueDescription(enriched.description)) {
        const fromProse = enrichIssueDraftWithLatestAnalysis(
          enriched,
          stripIssueDraftJsonFromAgentText(finalText),
        );
        enriched = fromProse;
      }
      if (enriched.description !== parsed.description) {
        logger.info("BA thread issue draft enriched", {
          threadId: opts.threadId,
          thinChars: parsed.description.length,
          enrichedChars: enriched.description.length,
          stillThin: isThinIssueDescription(enriched.description),
        });
      }
      logger.info("BA thread issue draft parsed", {
        threadId: opts.threadId,
        title: enriched.title.slice(0, 80),
      });
      return normalizeIssueDraftForForm(enriched);
    };

    return await withTimeout(work(), ISSUE_DRAFT_TIMEOUT_MS, "BA issue draft");
  } finally {
    session.end();
  }
}
