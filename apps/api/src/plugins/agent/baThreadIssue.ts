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
  resolveSystemCursorModelSpec,
  type BaMessage,
} from "../../workspace/baStore.js";
import { loadBaLinkedContext } from "../ba/ba-linked-context.js";
import { resolveBaUserGoogleAccessToken } from "../../modules/google/index.js";
import {
  baGitlabBoundaryInstructions,
  baPresentationRules,
  baSpecFormatInstructions,
} from "./baChat.js";
import { baBusinessLanguageRules } from "./baWorkflow.js";
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
  return `## Phân tích BA mới nhất trong hội thoại (ƯU TIÊN làm xương mục 1–3)
Đây là bản phân tích **gần nhất** trong chat. Các lượt Human/Assistant **sau** khối này (nếu có trong "Hội thoại cần review") có thể đã chỉnh phạm vi / cột / logic — **phải gộp vào** description; không bỏ qua để giữ nguyên bản cũ.

${latest.content.trim()}`;
}

/** Parse single issue JSON from agent output (tolerant + markdown fallback). */
export function parseIssueDraftFromAgent(text: string): BaThreadIssueDraft | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  for (const block of allCodeFenceBlocks(trimmed)) {
    const parsed = tryParseIssueJson(repairJsonLoose(block));
    if (parsed) return parsed;
  }

  for (const obj of extractJsonObjectsWithTitle(trimmed)) {
    const parsed = tryParseIssueJson(repairJsonLoose(obj));
    if (parsed) return parsed;
  }

  return fallbackIssueDraftFromProse(trimmed);
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
  return raw
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

function inferIssueLabel(_text: string): string[] {
  return [];
}

function fallbackIssueDraftFromProse(text: string): BaThreadIssueDraft | null {
  const body = text.replace(/```[\s\S]*?```/g, "").trim();
  if (!body) return null;
  if (/^\{[\s\S]*\}$/.test(body) && !/"title"\s*:/.test(body)) return null;

  let title = "";
  const descLines: string[] = [];
  const ac: string[] = [];

  for (const line of body.split("\n")) {
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
  return `Bạn là Business Analyst trên dự án **${opts.displayName}**.

## Nhiệm vụ
User bấm **Create issue** — hãy **chỉ tổng hợp hội thoại** dưới đây thành **một** GitLab issue draft cho Dev/QA theo **trạng thái đã chốt sau cùng** (không phải bản phân tích đầu tiên).

## Format mô tả issue (gợi ý — cùng format spec với BA mode)
${baSpecFormatInstructions()}

${baPresentationRules()}

## Quy tắc soạn draft
1. **Chỉ dùng hội thoại** (và block GitLab/Google nếu có sẵn) — **không** đọc source, **không** Grep/Glob/Read file, **không** gọi tool, **không** tra DB. **Tổng hợp theo thời gian** — lượt chat **sau** ghi đè / bổ sung lượt **trước**. Human chỉnh sửa, bác bỏ, hoặc chốt thêm → phải phản ánh vào description. Không bịa thông tin không có trong hội thoại. **Cấm** copy nguyên bản phân tích sớm rồi bỏ qua các lượt trao đổi sau.
2. **Title** — ngắn, rõ; lấy từ tên chức năng chính **đã chốt sau cùng**. **Không** nhồi format spec vào title.
3. **Description (markdown)** — **đúng tên đầu mục BA** khi có nội dung:
   - \`## 1. Yêu cầu khách hàng\` / \`## 2. Yêu cầu/Đề xuất từ PD\` = **đầu vào** — trích từ chat (đã cập nhật nếu YC đổi giữa chừng), không nhét phân tích BA.
   - \`## 3. Nội dung phân tích\` (+ \`3.1\` / \`3.1.x\` / \`3.2\` / \`3.3\` nếu có) = **phân tích BA đã chốt sau cùng** — gộp chỉnh sửa từ các lượt sau; bỏ qua nếu chat mới dừng ở YC thô.
   - **KHÔNG đưa mục 4 (Câu hỏi cần xác nhận)** vào description / task — chỉ dùng khi chat; lên issue thì **bỏ hẳn**. Điểm đã được Human trả lời/chốt trong chat → đưa vào mục 1–3, không để lại như câu hỏi mở.
   - Tối thiểu: mục 1 (+ mục 2 nếu có ý PD).
4. Chat đã có phân tích → **giữ cấu trúc mục 3** (và 3.1–3.3 nếu phù hợp) nhưng **nội dung phải là bản mới nhất** sau trao đổi — không đóng băng bản đầu. Cắt bỏ "Câu hỏi cần xác nhận". Giữ bảng danh sách / trường popup theo mẫu; kết luận dài → heading + câu/bullet, không nhét vào bảng.
5. **acceptanceCriteria** (JSON): luôn \`[]\` (schema giữ field).
6. **Không** gán label.

${baBusinessLanguageRules()}

**Cấm** mở workspace / đọc code / gọi tool. Trả lời ngay từ hội thoại.

GitLab (định danh dự án — không gọi API): ${opts.gitlabPath}
${baGitlabBoundaryInstructions()}

${opts.gitlabTaskBlock ? `${opts.gitlabTaskBlock}\n\n` : ""}${opts.latestAnalysisBlock ? `${opts.latestAnalysisBlock}\n\n` : ""}## Hội thoại cần review (đọc hết — ưu tiên lượt cuối)
${opts.threadBlock}

---

**Cuối câu trả lời**, thêm **một** block JSON (bắt buộc):

\`\`\`json
{"title":"…","description":"… (markdown: 1–2 đầu vào, 3 phân tích BA đã chốt sau cùng nếu có — KHÔNG mục 4)","labels":[],"acceptanceCriteria":[]}
\`\`\`

JSON phải parse được; \`description\` escape newline thành \\n; không comment trong JSON.`;
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
            if (chunk.startsWith(streamed) && chunk.length >= streamed.length) {
              streamed = chunk;
            } else if (chunk) {
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
      const finalText =
        fromResult.length >= streamed.length
          ? fromResult || streamed
          : streamed || fromResult;
      if (!finalText) throw new Error("Agent returned empty content");

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

      const parsed = parseIssueDraftFromAgent(finalText);
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
      logger.info("BA thread issue draft parsed", {
        threadId: opts.threadId,
        title: parsed.title.slice(0, 80),
      });
      return normalizeIssueDraftForForm(parsed);
    };

    return await withTimeout(work(), ISSUE_DRAFT_TIMEOUT_MS, "BA issue draft");
  } finally {
    session.end();
  }
}
