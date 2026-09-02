import { Agent } from "@cursor/sdk";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import {
  getBaProject,
  getBaProjectGitlabToken,
  getBaThread,
  isBaDbAccessAllowed,
  listBaMessages,
  resolveBaProjectDb,
  resolveSystemCursorApiKey,
  resolveSystemCursorModel,
  type BaMessage,
} from "../../workspace/baStore.js";
import { isGitRepo } from "../../workspace/clone.js";
import {
  ensureProjectGraphifyReady,
  formatBaGraphifyPromptBlock,
  queryProjectGraphify,
} from "../../workspace/graphify.js";
import { pullBaProjectLatest } from "../git/ba-pull.js";
import { buildBaDbCustomTools } from "../baDb/tools.js";
import { mergeBaAgentCustomTools } from "../ba/graphifyTools.js";
import { loadBaLinkedContext } from "../ba/ba-linked-context.js";
import { resolveBaUserGoogleAccessToken } from "../../modules/google/index.js";
import {
  BA_GITLAB_INTERACTION_ENABLED,
  baGitlabBoundaryInstructions,
  baPresentationRules,
  baReadOnlyWorkspaceRules,
  baSpecFormatInstructions,
} from "./baChat.js";
import { baBusinessLanguageRules } from "./baWorkflow.js";
import {
  beginCancellableJob,
  errorFromCursorRunStatus,
  isTransientCursorTransportError,
} from "./run.js";

const ISSUE_DRAFT_TIMEOUT_MS = 10 * 60 * 1000;

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
  mainBranch: string;
  threadBlock: string;
  gitlabTaskBlock: string;
  graphifyBlock?: string;
  dbAccess: { allowed: boolean; dialect?: string; database?: string };
}): string {
  const dbBlock = opts.dbAccess.allowed
    ? `Database read-only: ON (${opts.dbAccess.dialect} / ${opts.dbAccess.database}). Chỉ dùng tool query khi cần xác minh tên UI/field.`
    : "Database: OFF.";

  return `Bạn là Business Analyst trên dự án **${opts.displayName}**.

## Nhiệm vụ
User bấm **Create issue** — hãy **review toàn bộ hội thoại** dưới đây và soạn **một** GitLab issue draft cho Dev/QA.

## Format mô tả issue (gợi ý — cùng format spec với BA mode)
${baSpecFormatInstructions()}

${baPresentationRules()}

## Quy tắc soạn draft
1. **Tổng hợp** từ hội thoại — không bịa (trừ khi cần tra source để đúng tên UI).
2. **Title** — ngắn, rõ; lấy từ tên chức năng chính (thường từ mục 1).
3. **Description (markdown):**
   - Mục **1–2** = **đầu vào** (YC gốc / PD) — trích từ chat, không nhét phân tích BA vào đây.
   - Mục **3** = **phân tích BA** — phần chính khi đã có trao đổi phân tích; có thể bỏ qua nếu chat mới dừng ở YC thô.
   - **KHÔNG đưa mục 4 (Câu hỏi cần xác nhận)** vào description / task — mục đó chỉ dùng khi chat hoặc phân tích; lên issue thì **bỏ hẳn**. Nếu chat còn câu hỏi mở: **không** copy vào mô tả issue.
   - Tối thiểu: mục 1 (+ mục 2 nếu có ý PD).
4. Chat đã có phân tích → **giữ mục 3** (ý đã chốt), **cắt bỏ** heading/đoạn "Câu hỏi cần xác nhận". Nếu chat đã nhét kết luận / IN-OUT vào bảng → **viết lại** heading + câu/bullet; chỉ giữ bảng catalog trường / ma trận bước kiểm tra.
5. **acceptanceCriteria** (JSON): luôn \`[]\` — **không** sinh user story / AC (Given–When–Then).
6. **Không** gán label.

${baBusinessLanguageRules()}

**Chỉ đọc source khi cần** xác minh tên màn hình/nút (locale vi) — không sửa file, không tạo file. Ưu tiên Code map graphify (nếu có) rồi mới mở file.

## Ranh giới workspace (CHỈ ĐỌC)
${baReadOnlyWorkspaceRules({ mainBranch: opts.mainBranch })}
${baGitlabBoundaryInstructions()}
${dbBlock}

${opts.graphifyBlock ? `${opts.graphifyBlock}\n\n` : ""}${opts.gitlabTaskBlock ? `${opts.gitlabTaskBlock}\n\n` : ""}## Hội thoại cần review
${opts.threadBlock}

---

**Cuối câu trả lời**, thêm **một** block JSON (bắt buộc):

\`\`\`json
{"title":"…","description":"… (markdown: 1–2 đầu vào, 3 phân tích BA nếu có — KHÔNG mục 4)","labels":[],"acceptanceCriteria":[]}
\`\`\`

JSON phải parse được; \`description\` escape newline thành \\n; không comment trong JSON.`;
}

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
    if (
      project.cloneStatus !== "ready" ||
      !(await isGitRepo(project.localPath))
    ) {
      throw new Error("Project chưa sẵn sàng — liên hệ admin");
    }

    const messages = await listBaMessages(opts.threadId);
    const threadBlock = formatThreadBlock(messages);
    if (!threadBlock.trim()) {
      throw new Error("Chưa có hội thoại để tổng hợp issue");
    }

    session.check();
    progress("Đang pull source mới nhất…", "pull");
    await pullBaProjectLatest(project);
    session.check();

    const apiKey = await resolveSystemCursorApiKey();
    const modelId = await resolveSystemCursorModel();
    const dbAllowed = isBaDbAccessAllowed(project);
    const dbCfg = dbAllowed ? await resolveBaProjectDb(project.id) : null;
    const dbAccess = {
      allowed: Boolean(dbCfg),
      dialect: dbCfg?.dialect,
      database: dbCfg?.database,
    };

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

    progress("Đang chuẩn bị code map (graphify)…", "read");
    await ensureProjectGraphifyReady(project.localPath, { timeoutMs: 90_000 });
    session.check();
    const graphifyQuery = await queryProjectGraphify(
      project.localPath,
      userTexts.slice(-4).join(" | ") || threadBlock.slice(0, 400),
    );
    const graphifyBlock = formatBaGraphifyPromptBlock({
      sourcePath: project.localPath,
      queryText: graphifyQuery,
    });
    session.check();

    const prompt = buildThreadIssuePrompt({
      displayName: project.displayName,
      gitlabPath: project.gitlabPath,
      mainBranch: project.mainBranch || "main",
      threadBlock,
      gitlabTaskBlock: linked.block,
      graphifyBlock,
      dbAccess,
    });

    logger.info("BA thread issue draft starting", {
      threadId: opts.threadId,
      projectId: opts.baProjectId,
      messageCount: messages.length,
    });

    progress("Agent đang soạn issue…", "agent");

    const work = async (): Promise<BaThreadIssueDraft> => {
      session.check();
      const customTools = mergeBaAgentCustomTools(
        project.localPath,
        dbCfg ? (buildBaDbCustomTools(dbCfg) as never) : null,
      );
      const agent = await Agent.create({
        apiKey,
        model: { id: modelId },
        ...(BA_GITLAB_INTERACTION_ENABLED ? {} : { mcpServers: {} }),
        local: {
          cwd: project.localPath,
          ...(BA_GITLAB_INTERACTION_ENABLED ? {} : { settingSources: [] }),
          // Không sandbox: customTools DB/graphify cần chạy không qua cổng phê duyệt headless.
          ...(Object.keys(customTools).length
            ? { customTools: customTools as never }
            : {}),
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

      const parsed = parseIssueDraftFromAgent(finalText);
      if (!parsed) {
        logger.warn("BA thread issue draft parse failed", {
          threadId: opts.threadId,
          preview: finalText.slice(0, 600),
          length: finalText.length,
        });
        throw new AppError(
          "Agent không trả về JSON issue hợp lệ — thử chat thêm chi tiết rồi bấm lại",
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
