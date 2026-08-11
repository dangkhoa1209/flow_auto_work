import { Agent } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { logger } from "../../logger.js";
import { publishRealtime } from "../realtime/hub.js";
import {
  beginCancellableJob,
  cancelActiveAgentRun,
  clearJobKillRequested,
  formatCursorAgentFailure,
  isJobKillRequested,
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

/** Cancel key for BA runs (reuse Force Stop registry). */
export function baCancelKey(threadId: string): string {
  return `ba:${threadId}`;
}

export async function stopBaThreadAgent(threadId: string): Promise<boolean> {
  return cancelActiveAgentRun(baCancelKey(threadId));
}

setMaxListeners(50);

const BA_TIMEOUT_MS = 10 * 60 * 1000;

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

function publishBaProgress(opts: {
  userId: string;
  threadId: string;
  messageId?: string;
  step: "pull" | "start" | "read" | "write" | "done" | "error";
  label: string;
  detail?: string;
}) {
  publishRealtime({
    type: "ba_progress",
    userId: opts.userId,
    threadId: opts.threadId,
    messageId: opts.messageId,
    step: opts.step,
    label: opts.label,
    detail: opts.detail,
  });
}

/** BA / PM / QC non-tech assistant — UI + locale vi terminology, no code changes. */
function buildBaPrompt(opts: {
  displayName: string;
  gitlabPath: string;
  mainBranch: string;
  historyBlock: string;
  question: string;
}): string {
  return `Bạn là trợ lý sản phẩm cho BA / PD / QC.

## 1. Phạm vi công việc & Ranh giới vai trò
- **Nhiệm vụ chính:** Tập trung hoàn toàn vào việc giải thích hành vi sản phẩm, luồng nghiệp vụ và hướng dẫn thao tác cho người dùng.
- **Ranh giới kỹ thuật:** Tuyệt đối không can thiệp, đề xuất hoặc thực hiện bất kỳ thay đổi nào liên quan đến mã nguồn (code). Không sửa file, không refactor, không viết patch.
- **Kịch bản từ chối:** Nếu nhận được yêu cầu sửa lỗi phần mềm hoặc thay đổi logic lập trình, khéo léo từ chối và hướng dẫn tạo yêu cầu (ticket) chuyển sang bộ phận Phát triển (Dev).
- Được phép đọc UI / locale / docs để trả lời chính xác — rồi dừng và trả lời. Không commit / push / MR / lệnh phá hủy.

## 2. Chuẩn hóa Giao diện & Ngôn ngữ (UI & Tiếng Việt)
- **Khớp tuyệt đối với màn hình:** Tên nút bấm, ô nhập liệu, menu hay thông báo phải chính xác 100% theo bản tiếng Việt đang chạy trên hệ thống (locale \`vi\`).
- **Tránh từ ngữ tự chế:** Không tự đặt tên cho màn hình hoặc nút bấm nếu trên giao diện không có.

## 3. Phong cách giao tiếp & Trình bày
- **Nói ngôn ngữ người dùng:** Không dùng thuật ngữ lập trình hay kỹ thuật phức tạp (database, API, class, commit…). Mọi giải thích quy về thao tác và trải nghiệm người dùng.
- **Tự nhiên & Trực tiếp:** Viết như người hướng dẫn thật. Không đính kèm chú thích thừa như “(theo UI)”, “(tiếng Việt)”, “(trong code)”.
- **Ngắn gọn & Có cấu trúc:** Đi thẳng vào vấn đề; dùng gạch đầu dòng hoặc chia từng bước thao tác rõ ràng.

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
  const cancelKey = baCancelKey(opts.threadId);
  // Honor Stop pressed before this run registered; also drop stale flags.
  const earlyStop = isJobKillRequested(cancelKey);
  clearJobKillRequested(cancelKey);
  if (earlyStop) {
    throw new Error("Force-stopped from UI");
  }
  const session = beginCancellableJob(cancelKey);

  try {
    const project = await getBaProject(opts.baProjectId);
    if (!project) throw new Error("BA project not found");
    if (
      project.cloneStatus !== "ready" ||
      !(await isGitRepo(project.localPath))
    ) {
      throw new Error("Project chưa sẵn sàng — liên hệ admin để clone source");
    }

    publishBaProgress({
      userId: opts.userId,
      threadId: opts.threadId,
      messageId: opts.assistantMessageId,
      step: "pull",
      label: "Đang đồng bộ code mới nhất…",
      detail: project.mainBranch || "main",
    });

    session.check();
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
    session.check();

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

    publishBaProgress({
      userId: opts.userId,
      threadId: opts.threadId,
      messageId: opts.assistantMessageId,
      step: "start",
      label: "Khởi động trợ lý…",
      detail: modelId,
    });

    const work = async (): Promise<string> => {
      session.check();
      const agent = await Agent.create({
        apiKey,
        model: { id: modelId },
        local: { cwd: project.localPath },
      });

      await using disposed = agent;
      session.check();

      publishBaProgress({
        userId: opts.userId,
        threadId: opts.threadId,
        messageId: opts.assistantMessageId,
        step: "read",
        label: "Đang đọc UI / locale & suy nghĩ…",
        detail: project.displayName,
      });

      const run = await disposed.send(prompt);
      session.attach(run);

      let streamed = "";
      let lastPublished = "";
      let wroteOnce = false;

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

            let delta = "";
            if (chunk.startsWith(streamed) && chunk.length >= streamed.length) {
              delta = chunk.slice(streamed.length);
              streamed = chunk;
            } else if (streamed && streamed.endsWith(chunk)) {
              delta = "";
            } else {
              delta = chunk;
              streamed += chunk;
            }

            if (delta) {
              if (!wroteOnce) {
                wroteOnce = true;
                publishBaProgress({
                  userId: opts.userId,
                  threadId: opts.threadId,
                  messageId: opts.assistantMessageId,
                  step: "write",
                  label: "Đang soạn câu trả lời…",
                });
              }
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
        const msg = err instanceof Error ? err.message : String(err);
        if (/Force-stopped|cancelled/i.test(msg)) {
          const stopped = new Error("Force-stopped from UI") as Error & {
            partial?: string;
          };
          stopped.partial = streamed || lastPublished;
          throw stopped;
        }
        session.check();
        if (!isTransientCursorTransportError(err)) {
          logger.warn("BA chat stream error; waiting for result", {
            err: msg,
          });
        }
      }

      try {
        session.check();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Force-stopped|cancelled/i.test(msg)) {
          const stopped = new Error("Force-stopped from UI") as Error & {
            partial?: string;
          };
          stopped.partial = streamed || lastPublished;
          throw stopped;
        }
        throw err;
      }
      const result = await run.wait();
      if (result.status === "cancelled") {
        const stopped = new Error("Force-stopped from UI") as Error & {
          partial?: string;
        };
        stopped.partial = streamed || lastPublished;
        throw stopped;
      }
      if (result.status === "error") {
        throw new Error(
          formatCursorAgentFailure(
            new Error(
              String((result as { result?: string }).result || "error"),
            ),
            "BA agent failed",
          ),
        );
      }

      const fromResult = String(
        (result as { result?: string }).result || "",
      ).trim();
      const fromStream = streamed.trim() || lastPublished.trim();
      const finalText =
        fromResult.length >= fromStream.length
          ? fromResult || fromStream
          : fromStream || fromResult;

      if (!finalText) {
        throw new Error("Agent returned an empty answer");
      }

      if (finalText.length > lastPublished.length) {
        let delta = "";
        if (finalText.startsWith(lastPublished)) {
          delta = finalText.slice(lastPublished.length);
        } else if (!lastPublished) {
          delta = finalText;
        }
        if (delta) {
          if (!wroteOnce) {
            publishBaProgress({
              userId: opts.userId,
              threadId: opts.threadId,
              messageId: opts.assistantMessageId,
              step: "write",
              label: "Đang soạn câu trả lời…",
            });
          }
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
      const answer = await withTimeout(work(), BA_TIMEOUT_MS, "BA chat");
      publishBaProgress({
        userId: opts.userId,
        threadId: opts.threadId,
        messageId: opts.assistantMessageId,
        step: "done",
        label: "Xong",
      });
      return answer;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (/Force-stopped|cancelled/i.test(raw)) {
        const stopped = new Error("Force-stopped from UI") as Error & {
          partial?: string;
        };
        stopped.partial = (err as Error & { partial?: string }).partial;
        throw stopped;
      }
      throw new Error(
        formatCursorAgentFailure(
          err,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  } finally {
    session.end();
    clearJobKillRequested(cancelKey);
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
      const stopped = /Force-stopped|cancelled/i.test(msg);
      const partial =
        (err as Error & { partial?: string }).partial?.trim() || "";
      logger.error("BA chat agent failed", {
        threadId: opts.threadId,
        err: msg,
        stopped,
      });

      const msgs = await listBaMessages(opts.threadId).catch(() => []);
      const existing =
        msgs.find((m) => m.id === assistantId)?.content?.trim() ||
        partial;
      const body = stopped
        ? existing
          ? `${existing}\n\n⏹ Đã dừng theo yêu cầu.`
          : "⏹ Đã dừng theo yêu cầu."
        : existing
          ? existing
          : `⚠️ ${msg}`;

      try {
        await updateBaMessageContent(assistantId, body);
      } catch {
        /* ignore */
      }

      if (stopped) {
        publishRealtime({
          type: "ba_done",
          userId: opts.userId,
          threadId: opts.threadId,
          messageId: assistantId,
          content: body,
        });
        publishBaProgress({
          userId: opts.userId,
          threadId: opts.threadId,
          messageId: assistantId,
          step: "done",
          label: "Đã dừng",
        });
      } else {
        publishRealtime({
          type: "ba_error",
          userId: opts.userId,
          threadId: opts.threadId,
          messageId: assistantId,
          error: msg,
        });
        publishBaProgress({
          userId: opts.userId,
          threadId: opts.threadId,
          messageId: assistantId,
          step: "error",
          label: "Gặp lỗi",
          detail: msg.slice(0, 120),
        });
      }
    }
  })();
}
