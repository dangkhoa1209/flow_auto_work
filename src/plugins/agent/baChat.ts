import { Agent } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { logger } from "../../logger.js";
import { publishRealtime } from "../realtime/hub.js";
import {
  formatCursorAgentFailure,
  isTransientCursorTransportError,
} from "./run.js";
import {
  appendBaMessage,
  getBaProject,
  listBaMessages,
  resolveSystemCursorApiKey,
  resolveSystemCursorModel,
  updateBaMessageContent,
  updateBaThreadTitle,
} from "../../workspace/baStore.js";
import { isGitRepo } from "../../workspace/clone.js";
import { pullBaProjectLatest } from "../git/ba-pull.js";

setMaxListeners(50);

const BA_TIMEOUT_MS = 4 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${Math.round(ms / 1000)}s — try a shorter question`,
        ),
      );
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

/** BA / PM / QC non-tech assistant — UI + locale vi terminology, no code changes. */
function buildBaPrompt(opts: {
  displayName: string;
  gitlabPath: string;
  mainBranch: string;
  historyBlock: string;
  question: string;
}): string {
  return `Bạn là trợ lý sản phẩm cho BA / PD / QC (người không chuyên kỹ thuật).

## Hard rules (bắt buộc)
1. Trả lời **non-tech**: dễ hiểu, tránh jargon code (class, API, DB schema, PR, commit…) trừ khi người hỏi chủ động hỏi kỹ thuật.
2. **Neo theo UI và locale vi**: dùng đúng chữ trên màn hình / nhãn nút / menu / message trong locale tiếng Việt của hệ thống (i18n \`vi\`, file locale/lang). Không bịa tên màn hình hay nút.
3. Chỉ **hỏi–đáp / giải thích hành vi sản phẩm**. Không được yêu cầu, đề xuất hay thực hiện **bất kỳ thay đổi code** nào (không sửa file, không refactor, không viết patch, không bảo “đổi dòng X”).
4. Nếu người hỏi muốn sửa code / implement: từ chối nhẹ nhàng và gợi ý chuyển Dev WorkBench / ticket cho Dev.
5. Được phép đọc/grep UI, locale, docs để trả lời — rồi **dừng và trả lời**. Không commit/push/MR/lệnh phá hủy.
6. Trả lời bằng **tiếng Việt**, ngắn gọn, có cấu trúc (bước thao tác UI nếu cần).

## Project
Tên: ${opts.displayName}
GitLab: ${opts.gitlabPath}
Branch: ${opts.mainBranch}

${opts.historyBlock ? `## Hội thoại trước\n${opts.historyBlock}\n` : ""}
## Câu hỏi
${opts.question}`;
}

/**
 * Ask-only Cursor run against a shared BA project source with token streaming.
 * Pulls latest git before each run.
 */
export async function runBaChatAgent(opts: {
  userId: string;
  threadId: string;
  baProjectId: string;
  question: string;
  assistantMessageId: string;
}): Promise<string> {
  const project = await getBaProject(opts.baProjectId);
  if (!project) throw new Error("BA project not found");
  if (project.cloneStatus !== "ready" || !(await isGitRepo(project.localPath))) {
    throw new Error("Project chưa sẵn sàng — liên hệ admin để clone source");
  }

  try {
    await pullBaProjectLatest(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("BA git pull failed", {
      projectId: project.id,
      err: msg,
    });
    throw new Error(
      `Không kéo được code mới nhất (git pull): ${msg.replace(/oauth2:[^@\s]+@/gi, "oauth2:***@")}`,
    );
  }

  const apiKey = await resolveSystemCursorApiKey();
  const modelId = await resolveSystemCursorModel();

  const history = await listBaMessages(opts.threadId);
  const historyBlock = history
    .filter((m) => m.id !== opts.assistantMessageId && m.content?.trim())
    .slice(-20)
    .map((m) => {
      const who = m.role === "user" ? "Human" : "Assistant";
      return `### ${who}\n${m.content.trim()}`;
    })
    .join("\n\n");

  const prompt = buildBaPrompt({
    displayName: project.displayName,
    gitlabPath: project.gitlabPath,
    mainBranch: project.mainBranch || "main",
    historyBlock,
    question: opts.question,
  });

  logger.info("BA chat agent starting", {
    threadId: opts.threadId,
    projectId: opts.baProjectId,
    model: modelId,
  });

  const work = async (): Promise<string> => {
    const agent = await Agent.create({
      apiKey,
      model: { id: modelId },
      local: { cwd: project.localPath },
    });

    await using disposed = agent;
    const run = await disposed.send(prompt);

    let streamed = "";
    let lastPublished = "";

    try {
      if (
        typeof run.stream === "function" &&
        run.supports?.("stream") !== false
      ) {
        for await (const message of run.stream()) {
          const full = extractAssistantText(
            message as {
              type?: string;
              message?: { content?: Array<{ type?: string; text?: string }> };
            },
          );
          if (!full) continue;
          let delta = "";
          if (full.startsWith(streamed)) {
            delta = full.slice(streamed.length);
            streamed = full;
          } else if (full.length > streamed.length) {
            delta = full.slice(streamed.length);
            streamed = full;
          } else {
            streamed = full;
            delta = "";
          }
          if (delta) {
            lastPublished = streamed;
            publishRealtime({
              type: "ba_delta",
              userId: opts.userId,
              threadId: opts.threadId,
              messageId: opts.assistantMessageId,
              delta,
            });
          }
        }
      }
    } catch (err) {
      if (!isTransientCursorTransportError(err)) {
        logger.warn("BA chat stream error; waiting for result", {
          err: String(err),
        });
      }
    }

    const result = await run.wait();
    if (result.status === "error") {
      throw new Error(
        formatCursorAgentFailure(
          new Error(String((result as { result?: string }).result || "error")),
          "BA agent failed",
        ),
      );
    }
    if (result.status === "cancelled") {
      throw new Error("BA chat cancelled");
    }

    const finalText =
      streamed.trim() ||
      String((result as { result?: string }).result || "").trim() ||
      lastPublished.trim();

    if (!finalText) {
      throw new Error("Agent returned an empty answer");
    }

    if (
      finalText.length > lastPublished.length &&
      finalText.startsWith(lastPublished)
    ) {
      const delta = finalText.slice(lastPublished.length);
      if (delta) {
        publishRealtime({
          type: "ba_delta",
          userId: opts.userId,
          threadId: opts.threadId,
          messageId: opts.assistantMessageId,
          delta,
        });
      }
    }

    return finalText;
  };

  try {
    return await withTimeout(work(), BA_TIMEOUT_MS, "BA chat");
  } catch (err) {
    throw new Error(
      formatCursorAgentFailure(
        err,
        err instanceof Error ? err.message : String(err),
      ),
    );
  }
}

/** Persist placeholder + run agent in background. */
export function kickBaChatAnswer(opts: {
  userId: string;
  threadId: string;
  baProjectId: string;
  question: string;
  isFirstUserMessage: boolean;
}): void {
  const assistantId = `bam_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  void (async () => {
    try {
      const placeholder = await appendBaMessage({
        id: assistantId,
        threadId: opts.threadId,
        role: "assistant",
        content: "",
      });
      publishRealtime({
        type: "ba_message",
        userId: opts.userId,
        threadId: opts.threadId,
        message: placeholder,
      });

      const answer = await runBaChatAgent({
        userId: opts.userId,
        threadId: opts.threadId,
        baProjectId: opts.baProjectId,
        question: opts.question,
        assistantMessageId: assistantId,
      });

      await updateBaMessageContent(assistantId, answer);
      publishRealtime({
        type: "ba_done",
        userId: opts.userId,
        threadId: opts.threadId,
        messageId: assistantId,
        content: answer,
      });

      if (opts.isFirstUserMessage) {
        const title =
          opts.question.trim().slice(0, 60) +
          (opts.question.trim().length > 60 ? "…" : "");
        await updateBaThreadTitle(opts.threadId, title);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("BA chat agent failed", {
        threadId: opts.threadId,
        err: msg,
      });
      try {
        await updateBaMessageContent(assistantId, `⚠️ ${msg}`);
      } catch {
        /* ignore */
      }
      publishRealtime({
        type: "ba_error",
        userId: opts.userId,
        threadId: opts.threadId,
        messageId: assistantId,
        error: msg,
      });
    }
  })();
}
