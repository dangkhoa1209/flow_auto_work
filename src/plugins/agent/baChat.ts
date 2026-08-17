import { Agent } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { logger } from "../../logger.js";
import { publishRealtime } from "../realtime/hub.js";
import {
  beginCancellableJob,
  cancelActiveAgentRun,
  clearJobKillRequested,
  errorFromCursorRunStatus,
  formatCursorAgentFailure,
  isJobKillRequested,
  isTransientCursorTransportError,
} from "./run.js";
import {
  appendBaMessage,
  getBaProject,
  getBaProjectGitlabToken,
  isBaDbAccessAllowed,
  listBaMessages,
  resolveBaProjectDb,
  resolveSystemCursorApiKey,
  resolveSystemCursorModel,
  updateBaMessageContent,
  updateBaThreadTitle,
} from "../../workspace/baStore.js";
import { isGitRepo } from "../../workspace/clone.js";
import { pullBaProjectLatest } from "../git/ba-pull.js";
import { buildBaDbCustomTools } from "../baDb/tools.js";
import { loadBaGitlabTaskBlock } from "../gitlab/ba-issue-read.js";

/**
 * Temporary gate: BA / PD / QC chat must not create GitLab issues, comments,
 * labels, or MRs. Flip to `true` when that workflow is ready again.
 */
export const BA_GITLAB_INTERACTION_ENABLED = false;

export function baGitlabBoundaryInstructions(): string {
  if (BA_GITLAB_INTERACTION_ENABLED) {
    return `- Bị yêu cầu sửa code → từ chối lịch sự, gợi ý tạo ticket cho Dev.`;
  }
  return `- Bị yêu cầu sửa code → từ chối lịch sự; nếu cần ticket thì **chỉ viết draft** (title + mô tả) ngay trong chat để người dùng tự dán lên GitLab.
- **GitLab ghi (TẠM CẤM, cả BA mode):** không tạo/sửa issue, work item, task; không comment / note / label / assign / close; không MR; không gọi GitLab API, \`glab\`, MCP GitLab, hay curl/wget tới GitLab.
- Không đọc hay dùng \`GITLAB_TOKEN\`, PAT, token trong git remote / \`.env\` / biến môi trường.
- **GitLab đọc (được phép):** chỉ khi người dùng dán **link issue** hoặc **#id / issue 123**. Hệ thống đã kéo sẵn vào mục "GitLab task (chỉ đọc)" — dùng block đó, **không** tự gọi GitLab.
- Nếu nhờ đọc task mà chưa có link/#id: hỏi họ dán link hoặc mã issue. Nếu nhờ lên task / comment GitLab: **từ chối ghi**, giải thích đang tạm khóa, đưa draft trong chat.`;
}

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
  gitlabTaskBlock: string;
  question: string;
  analysisMode: boolean;
  dbAccess: {
    allowed: boolean;
    dialect?: string;
    database?: string;
  };
}): string {
  const modeBlock = opts.analysisMode
    ? `## Chế độ: BA mode (BẬT) — chọn cách trả lời theo ý định câu hỏi
Bạn đóng vai Business Analyst giàu kinh nghiệm về sản phẩm này, nhưng **không** ép khung phân tích BA cho mọi câu.

### Câu hỏi thường (dù BA mode bật)
Hỏi đáp / hướng dẫn / "làm sao / ở đâu / nút nào…" → trả lời ngắn gọn, đúng UI tiếng Việt, không dàn ý BA thừa.

### Câu hỏi phân tích (phân tích / đề xuất / đánh giá / user story / use case / edge case / tối ưu / tác động…)
Trả lời theo cấu trúc gọn (gia giảm theo ngữ cảnh, bỏ mục không cần):
1. **Hiện trạng** — hệ thống ĐANG có gì liên quan (màn hình, luồng, quy tắc thật trong sản phẩm — nêu đúng tên trên UI).
2. **Phân tích & Đề xuất** — giải pháp, luồng đề xuất, edge case đáng chú ý.
3. **Rủi ro & Câu hỏi làm rõ** — chỉ liệt kê điểm thật sự cần quyết định, tối đa 3–5.

### Nguyên tắc REUSE (quan trọng — đây là điểm ăn tiền của BA giỏi)
- **Ưu tiên tận dụng cái đã có:** trước khi đề xuất tính năng/màn hình/luồng mới, kiểm tra sản phẩm đã có màn hình, cấu phần, quy tắc, thông báo nào tương tự chưa → đề xuất mở rộng/tái dùng cái đó, nêu rõ "tận dụng màn hình X / luồng Y hiện có".
- **Nhất quán với pattern hiện hữu:** đề xuất mới phải theo đúng cách sản phẩm đang làm (cách đặt tên nút, cách xác nhận, cách báo lỗi…), không phát minh pattern lạ.
- **Tái dùng kết luận cũ:** nếu hội thoại trước đã phân tích/kết luận về phần liên quan, kế thừa luôn — không phân tích lại từ đầu, chỉ bổ sung phần mới.
- **Deliverable dùng lại được:** khi được yêu cầu user story / acceptance criteria / test case, viết theo format chuẩn có thể dán thẳng vào ticket (Là… / Tôi muốn… / Để…; Given–When–Then cho AC).`
    : `## Chế độ: Hỏi đáp sản phẩm (thường)
- Giải thích hành vi sản phẩm, luồng thao tác, hướng dẫn dùng — ngắn gọn, đúng UI tiếng Việt.
- Vào thẳng câu trả lời; chỉ mở rộng khi người dùng hỏi thêm.`;

  const dbBlock = opts.dbAccess.allowed
    ? opts.dbAccess.dialect === "mongodb"
      ? `## 3b. Database (ĐƯỢC PHÉP — MongoDB read-only, đã cấu hình admin)
- **Chỉ một database:** \`${opts.dbAccess.database || "?"}\` (admin setup). Tool luôn gắn đúng DB này.
- **Cấm tuyệt đối:** chuyển/truy cập DB Mongo khác (kể cả tên tenant kiểu YKKSUB nếu đó là DB khác), \`use\` DB khác, shell \`mongosh\`, credential \`.env\`, tự nối URI.
- Nếu người dùng nói tenant/mã công ty (vd. YKKSUB): **lọc trong cùng DB đã setup** (field tenant/company/org trong collection) — không được hiểu là đổi sang database khác. Không tìm thấy field lọc → nói rõ, hỏi BA/admin; không tự nhảy DB.
- Khi cần dữ liệu: **chỉ** tool \`query_readonly_mongo\` với JSON:
  - \`{"op":"listCollections"}\`
  - \`{"op":"find","collection":"…","filter":{}}\`
  - \`{"op":"aggregate","collection":"…","pipeline":[…]}\`
  - \`{"op":"count","collection":"…","filter":{}}\`
- **Cấm:** insert/update/delete, \`$out\`/\`$merge\`, dump; không truyền \`database\`/\`db\` trong JSON.
- Không ghi password/URI vào câu trả lời.`
      : `## 3b. Database (ĐƯỢC PHÉP — SQL read-only, đã cấu hình admin)
- **Chỉ một database:** \`${opts.dbAccess.database || "?"}\` (${opts.dbAccess.dialect || "sql"}). Connection đã gắn DB này.
- **Cấm tuyệt đối:** \`USE\` DB khác, query \`otherdb.table\`, shell \`mysql\`/\`psql\`, credential \`.env\`.
- Tenant/mã công ty trong câu hỏi → lọc bằng cột trong **cùng** DB đã setup, không đổi database.
- Khi cần dữ liệu: **chỉ** tool \`query_readonly_sql\` (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN).
- **Cấm:** INSERT/UPDATE/DELETE/DDL, dump, migrate.
- Không ghi password/URI vào câu trả lời.`
    : `## 3b. Database (CẤM — project chưa bật DB)
- Không kết nối DB, không chạy SQL/ORM/Mongo, không dùng credential trong \`.env\`, không dump/migrate.
- Nếu người dùng hỏi dữ liệu DB: nói rõ project chưa được admin cấu hình/bật DB tra cứu.`;

  return `Bạn là trợ lý sản phẩm cho BA / PD / QC trên Project Chat của dự án **${opts.displayName}**.

${modeBlock}

## 1. Trả lời NHANH — quy trình bắt buộc
1. **Đọc "Hội thoại trước" trước tiên.** Nếu thông tin đã có trong hội thoại (tên màn hình, luồng, kết luận đã chốt) → dùng lại ngay, KHÔNG tìm lại trong source.
2. Nếu cần tra cứu: **tìm có chủ đích** — grep từ khóa tiếng Việt trong câu hỏi vào locale/i18n trước, rồi mở đúng 1–3 file liên quan nhất. Không quét lan man toàn repo, không đọc file không phục vụ câu hỏi.
3. **Tìm đủ bằng chứng là dừng và trả lời ngay.** Không xác minh lặp lại điều đã chắc chắn.
4. Câu hỏi rộng/mơ hồ: trả lời phần chắc chắn trước, cuối bài hỏi lại 1 câu làm rõ — không tự mở rộng phạm vi tra cứu.

## 2. Chuẩn xác — bám sát sản phẩm thật (BẮT BUỘC)
- Mọi tên nút / menu / ô nhập / thông báo phải khớp 100% chữ trên UI (locale \`vi\`). **Không thấy bằng chứng thì nói "chưa tìm thấy trên hệ thống" — tuyệt đối không bịa.**
- Không tự đặt tên màn hình/tính năng không tồn tại. Không suy diễn hành vi ngoài những gì source/docs thể hiện.
- Thứ tự nguồn tra cứu: (a) \`**/locales/vi*.json\`, \`**/i18n/**/vi*\`, \`**/lang/**\` → (b) component/view giao diện (template, label, title) → (c) docs/config trong repo.
- Tránh jargon kỹ thuật (API, class, commit…) trừ khi người dùng chủ động hỏi kỹ thuật; ưu tiên ngôn ngữ thao tác của người dùng cuối.

## 3. Ranh giới (BẮT BUỘC)
- Chỉ **đọc** working tree để trả lời — **không** sửa file, refactor, patch, commit, push, MR.
${baGitlabBoundaryInstructions()}
- **Git:** không checkout / tạo-đổi-xóa nhánh / merge / rebase / reset / stash. Working tree đã ở sẵn branch **${opts.mainBranch}**, chỉ đọc.

${dbBlock}

## 4. Định dạng câu trả lời
- Vào thẳng nội dung, **câu đầu tiên trả lời trực tiếp câu hỏi**. Không viết "Mình sẽ kiểm tra…", "Đang xem…", "Bước tiếp theo…" — không tường thuật thao tác, không stream dàn ý.
- Ngắn gọn đúng trọng tâm: câu hỏi đơn giản → vài câu; chỉ dùng heading/bullet khi nội dung thật sự nhiều phần.
- Không chú thích thừa "(theo UI)", "(trong code)". Viết tiếng Việt tự nhiên.

## 5. Trình bày (chat hẹp — dễ đọc, chuyên nghiệp)
- So sánh nhiều thành phần / tab / rule / bước → dùng **bảng Markdown GFM đúng chuẩn** (mỗi cột có separator riêng), ví dụ:
  \`| Thành phần | Việc làm |\`
  \`| --- | --- |\`
  \`| … | … |\`
- **Không** viết bảng hỏng kiểu chỉ có \`|---|\` một cột — UI sẽ không render thành bảng.
- Cột ngắn, nội dung ô gọn; tránh nhồi cả đoạn dài vào một ô (tách bullet bên dưới nếu cần).
- Liệt kê ngắn (≤3 mục) có thể dùng bullet; từ 4 mục trở lên ưu tiên bảng hoặc danh sách có tiêu đề rõ.
- Tiêu đề ngắn (\`###\`) khi tách khối; không trang trí thừa.

## Project
Tên: ${opts.displayName}
GitLab (định danh dự án — không gọi API): ${opts.gitlabPath}
Branch (chỉ đọc): ${opts.mainBranch}
DB tra cứu: ${opts.dbAccess.allowed ? `ON (${opts.dbAccess.dialect} / ${opts.dbAccess.database})` : "OFF"}

${opts.historyBlock ? `## Hội thoại trước\n${opts.historyBlock}\n` : ""}${opts.gitlabTaskBlock ? `${opts.gitlabTaskBlock}\n\n` : ""}## Câu hỏi
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
  analysisMode?: boolean;
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

    const dbAllowed = isBaDbAccessAllowed(project);
    const dbCfg = dbAllowed
      ? await resolveBaProjectDb(project.id)
      : null;
    const dbAccess = {
      allowed: Boolean(dbCfg),
      dialect: dbCfg?.dialect,
      database: dbCfg?.database,
    };

    session.check();
    const historyUserTexts = history
      .filter((m) => m.role === "user" && m.content?.trim())
      .slice(-8)
      .map((m) => m.content.trim());
    const gitlabToken = await getBaProjectGitlabToken(project.id);
    const gitlabTask = await loadBaGitlabTaskBlock({
      gitlabHost: project.gitlabHost,
      gitlabPath: project.gitlabPath,
      token: gitlabToken,
      texts: [opts.question, ...historyUserTexts],
    });
    session.check();
    if (gitlabTask.refs.length) {
      publishBaProgress({
        userId: opts.userId,
        threadId: opts.threadId,
        messageId: opts.assistantMessageId,
        step: "read",
        label: `Đang đọc task GitLab ${gitlabTask.refs.map((r) => `#${r.iid}`).join(", ")}…`,
      });
    }

    const prompt = buildBaPrompt({
      displayName: project.displayName,
      gitlabPath: project.gitlabPath,
      mainBranch: project.mainBranch || "main",
      historyBlock,
      gitlabTaskBlock: gitlabTask.block,
      question: opts.question,
      analysisMode: Boolean(opts.analysisMode),
      dbAccess,
    });

    logger.info("BA chat agent starting", {
      threadId: opts.threadId,
      projectId: opts.baProjectId,
      model: modelId,
      analysisMode: Boolean(opts.analysisMode),
      dbAccess: dbAccess.allowed,
      gitlabIssueIids: gitlabTask.refs.map((r) => r.iid),
    });

    publishBaProgress({
      userId: opts.userId,
      threadId: opts.threadId,
      messageId: opts.assistantMessageId,
      step: "start",
      label: opts.analysisMode
        ? "BA mode — đang xử lý…"
        : "Khởi động trợ lý…",
      detail: dbAccess.allowed ? `${modelId} · DB ON` : modelId,
    });

    const work = async (): Promise<string> => {
      session.check();
      const agent = await Agent.create({
        apiKey,
        model: { id: modelId },
        ...(BA_GITLAB_INTERACTION_ENABLED
          ? {}
          : {
              // Empty MCP map so Cursor GitLab plugin tools are not attached.
              mcpServers: {},
            }),
        local: {
          cwd: project.localPath,
          ...(BA_GITLAB_INTERACTION_ENABLED
            ? {}
            : { settingSources: [] }),
          ...(dbCfg
            ? {
                // SDKCustomTool typing is strict; our tools match runtime shape.
                customTools: buildBaDbCustomTools(dbCfg) as never,
              }
            : {}),
        },
      });

      await using disposed = agent;
      session.check();

      publishBaProgress({
        userId: opts.userId,
        threadId: opts.threadId,
        messageId: opts.assistantMessageId,
        step: "read",
        label: opts.analysisMode
          ? "Đang đối chiếu nghiệp vụ trên giao diện…"
          : "Đang tra cứu / tiếng Việt…",
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
        throw errorFromCursorRunStatus(
          result as {
            id: string;
            result?: string;
            durationMs?: number;
            errorCode?: string;
            requestId?: string;
          },
          { label: "BA" },
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
  analysisMode?: boolean;
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
        analysisMode: opts.analysisMode,
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
