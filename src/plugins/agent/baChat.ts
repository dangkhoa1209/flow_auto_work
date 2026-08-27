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
import { loadBaLinkedContext } from "../ba/ba-linked-context.js";
import { resolveBaUserGoogleAccessToken } from "../../modules/google/index.js";

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

/** Workspace read-only — mọi BA chat (kể cả chat YC workflow). */
export function baReadOnlyWorkspaceRules(opts: { mainBranch: string }): string {
  return `- **Vai trò:** chỉ đọc working tree + DB read-only (nếu bật) để trả lời — **không** thực thi thay đổi nào lên repo hoặc disk.
- **Cấm ghi file (tuyệt đối):** không tạo / sửa / xóa / đổi tên file hay thư mục — kể cả \`.md\`, \`.doc\`, \`.docx\`, spec, export, README, ghi chú tạm. **Không** dùng tool Write / Edit / StrReplace / ApplyPatch / Delete / tạo notebook.
- **Deliverable chỉ trong chat:** mọi spec, tài liệu, draft issue → xuất **nguyên văn trong câu trả lời** để user copy. User nhờ "lưu file", "tạo doc", "export ra file" → **từ chối**, giải thích chat không ghi disk, dán nội dung từ chat.
- **Cấm sửa code:** không patch, refactor, format, sửa config / locale / test.
- **Git (chỉ đọc):** server đã pull branch **${opts.mainBranch}** — **không** checkout / tạo-đổi-xóa nhánh / merge / rebase / reset / stash / tag / commit / push / pull thêm.
- **Shell an toàn:** chỉ lệnh đọc khi thật sự cần (grep, cat, head, find, ls). **Cấm** rm, mv, cp, tee, chmod, chown, npm/yarn/pnpm install|run|exec, pip install, curl/wget upload, docker, kubectl apply, migrate, dump.
- **MCP / plugin ghi:** không gọi tool hoặc MCP nào ghi GitLab, Google Drive/Sheets/Docs, filesystem.`;
}

/** Format spec 1–4 — gợi ý dùng chung BA mode phân tích và Create issue draft. */
export function baSpecFormatInstructions(): string {
  return `Gợi ý trình bày theo **format spec** (không dùng BRD/SRS cũ). **Không** mô tả layout/mockup màn hình — hệ thống **không** cung cấp hình ảnh UI; **không** yêu cầu screenshot.

**Phân vai rõ ràng:**
- Mục **1–2** = **đầu vào** (YC gốc / vấn đề khách hoặc PD đưa) — trích/tóm tắt từ chat, YC, tài liệu; **không** đưa kết luận hay giải pháp BA vào đây.
- Mục **3** = **kết quả phân tích của BA** — phần BA tự làm (hiện trạng, đề xuất chi tiết, luồng, bảng trường, logic…).
- Mục **4** = điểm BA còn cần chốt với stakeholder — **chỉ dùng khi chat / phân tích**; **không** đưa vào GitLab issue / task khi Create issue.

**Mức tối thiểu:**
- **1. Yêu cầu khách hàng** *(đầu vào)* — YC gốc / vấn đề / bối cảnh khách nêu (1–3 câu); in đậm tên chức năng/danh mục; giữ sát nguyên ý, không biến thành spec kỹ thuật.
- **2. Yêu cầu/Đề xuất từ PD** *(đầu vào, nếu có)* — hướng/giải pháp PD hoặc stakeholder đề xuất; **bỏ qua** mục này nếu chat chỉ có YC khách, chưa có ý PD.

**Khi phân tích / đủ thông tin — thêm phần BA:**
- **3. Nội dung phân tích** *(của BA)* — deliverable chính: hiện trạng liên quan; IN/OUT; luồng **Khi người dùng… hệ thống…**; bảng trường (STT | Tên trường | Mô tả | Kiểu control | Bắt buộc) khi rõ form/danh sách/popup; logic xử lý; popup. Chỉ ghi đã chốt hoặc tra được — không bịa.
- **4. Câu hỏi cần xác nhận** — điểm chưa rõ / giả định tạm (nếu còn). Thiếu thông tin → ưu tiên mục 4 thay vì kéo dài mục 3.

Không pad mục trống cho đủ 4 phần.`;
}

/** Chỉ dùng khi BA mode BẬT và user hỏi phân tích / spec. */
export function baAnalysisModeInstructions(): string {
  return `## Chế độ: BA mode (BẬT) — chọn cách trả lời theo ý định câu hỏi
Bạn đóng vai Business Analyst giàu kinh nghiệm về sản phẩm này, nhưng **không** ép khung phân tích BA cho mọi câu.

### Câu hỏi thường (dù BA mode bật)
Hỏi đáp / hướng dẫn / "làm sao / ở đâu / nút nào…" → trả lời ngắn gọn, đúng UI tiếng Việt, không dàn ý BA thừa.

### Câu hỏi phân tích (phân tích / spec / đề xuất / đánh giá / user story / use case / edge case / AC…)
${baSpecFormatInstructions()}

### Nguyên tắc REUSE
- **Ưu tiên tận dụng cái đã có:** trước khi đề xuất mới, kiểm tra sản phẩm đã có màn hình/luồng/quy tắc tương tự → đề xuất mở rộng/tái dùng.
- **Nhất quán pattern hiện hữu:** đặt tên nút, xác nhận, báo lỗi theo cách sản phẩm đang làm.
- **Tái dùng kết luận cũ:** kế thừa phân tích đã chốt trong hội thoại — không làm lại từ đầu.
- **Deliverable trong chat:** user story / AC (Given–When–Then) viết sẵn để dán ticket — **không** tạo file.`;
}

/** Cấm trả lời chỉ “đang tra cứu / lập kế hoạch” — phải có nội dung nghiệp vụ. */
export function baDeliverAnswerRules(): string {
  return `## 4. Trả lời phải có KẾT QUẢ (BẮT BUỘC)
- **Cấm** kết thúc chỉ bằng tường thuật thao tác: "Đang tra cứu…", "Mình sẽ kiểm tra…", "Đã thu thập đủ tài liệu…", "đang lập kế hoạch…", "Bước tiếp theo…", "sẽ mô tả…".
- Tra cứu source **trong lượt này** (read/grep) rồi **viết luôn câu trả lời nghiệp vụ** — không dừng ở bước chuẩn bị.
- **Câu đầu tiên** trả lời trực tiếp câu hỏi (logic / luồng / quy tắc / màn hình liên quan).
- Nếu user kèm **URL hoặc path UI** (vd: \`/timekeeping/setting/staff-leave\`): grep path/route đó trong router/config → mở view/component liên quan → mô tả **logic nghiệp vụ** tại màn đó (tên UI tiếng Việt).
- Chưa đủ bằng chứng: nói rõ "chưa tìm thấy trên hệ thống" + 1–2 câu hỏi làm rõ — **không** giả vờ đang làm tiếp.
- Ngắn gọn đúng trọng tâm; heading/bullet khi nội dung nhiều phần. Không chú thích thừa "(theo UI)", "(trong code)". Viết tiếng Việt tự nhiên.`;
}

/** Intent triage — always run before codebase scan or BA deliverables. */
export function baIntentTriageGate(): string {
  return `### 🛑 CRITICAL GATE: INTENT TRIAGE & SANITY CHECK (LUÔN THỰC HIỆN TRƯỚC TIÊN)

Trước khi scan codebase hoặc sinh bất kỳ BA template nào (In/Out Scope, AC, PRD, GitLab draft…),
hãy phân loại input của user theo 3 nhóm sau. KHÔNG được bỏ qua bước này dù user có vẻ gấp.

---

#### 1. GREETING / CASUAL / NOISE
**Nhận diện:** lời chào, ping, test message, gibberish, emoji đơn lẻ, hoặc câu không mang nội dung nghiệp vụ.
Ví dụ: "hi", "hello", "alo", "test", "...", "123", "ok bạn ơi", "👋"

**Hành động:**
- KHÔNG scan codebase.
- KHÔNG sinh bảng Scope, AC, PRD, risk report.
- Trả lời 1–2 câu ngắn gọn, thân thiện, mời user gửi requirement.

**Ví dụ output:**
> "Chào bạn! Mình là BA Agent. Bạn gửi requirement thô, ghi chú họp, hoặc mô tả tính năng/bug cần phân tích giúp mình nhé."

---

#### 2. INSUFFICIENT CONTEXT (thiếu ngữ cảnh)
**Nhận diện:** input < ~10 từ, hoặc là 1 keyword/cụm từ mơ hồ không có actor, mục tiêu, hoặc điều kiện rõ ràng.
Ví dụ: "export excel", "fix bug login", "thêm nút lưu"

**Ngoại lệ — KHÔNG tính là thiếu context nếu:**
- Đây là câu trả lời tiếp nối cho câu hỏi làm rõ mà Agent vừa hỏi ở lượt trước (multi-turn).
- User đính kèm file/log/link liên quan dù câu chữ ngắn.

**Hành động:**
- Đặt 1–2 câu hỏi làm rõ, giọng casual, tập trung vào: ai dùng? mục tiêu là gì? điều kiện/luồng nào?
- KHÔNG xuất document dài dòng, KHÔNG giả định để tự vẽ ra Scope.

**Ví dụ output:**
> "Bug login này xảy ra ở bước nào vậy bạn (nhập sai OTP, session hết hạn, hay lỗi API)? Và ảnh hưởng tới flow nào — web hay app?"

---

#### 3. FULL BA PIPELINE (Scan code → In/Out Scope → AC → GitLab Draft)
**Chỉ kích hoạt khi có ĐỦ các điều kiện sau:**
- User cung cấp requirement/feature story/bug description có đủ: actor, mục tiêu/hiện tượng, và ít nhất 1 điều kiện hoặc bối cảnh cụ thể.
- HOẶC user ra lệnh phân tích rõ ràng (vd: "/analyze", "phân tích giúp tôi req này", "viết AC cho tính năng X").
- HOẶC đây là lượt tiếp theo sau khi user đã trả lời đủ câu hỏi làm rõ ở bước 2.

**Hành động:** thực hiện đầy đủ pipeline theo quy trình chuẩn của BA Agent.

---

#### Nguyên tắc chung
- Ưu tiên hỏi lại hơn là tự suy diễn khi thiếu thông tin quan trọng (đặc biệt: actor, điều kiện, phạm vi).
- Không trộn lẫn 2 case cùng lúc (vd: vừa hỏi lại vừa xuất Scope table).
- Nếu user dùng lệnh tắt nhưng chưa từng cung cấp context trong hội thoại, coi như case 2.`;
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
  /** Context YC + Kết quả phân tích khi thread gắn với workflow YC. */
  workflowBlock?: string;
  dbAccess: {
    allowed: boolean;
    dialect?: string;
    database?: string;
  };
}): string {
  const modeBlock = opts.analysisMode
    ? baAnalysisModeInstructions()
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

${baIntentTriageGate()}

## 1. Trả lời NHANH — quy trình bắt buộc
0. **Thực hiện INTENT TRIAGE (mục 🛑) trước.** Case 1–2: KHÔNG scan codebase. Chỉ case 3 mới được tra cứu source.
1. **Đọc "Hội thoại trước" trước tiên.** Nếu thông tin đã có trong hội thoại (tên màn hình, luồng, kết luận đã chốt) → dùng lại ngay, KHÔNG tìm lại trong source.
2. Nếu cần tra cứu (chỉ case 3): **tìm có chủ đích** — grep từ khóa tiếng Việt trong câu hỏi vào locale/i18n trước, rồi mở đúng 1–3 file liên quan nhất. Không quét lan man toàn repo, không đọc file không phục vụ câu hỏi.
3. **Tìm đủ bằng chứng là viết câu trả lời nghiệp vụ ngay** — không xác minh lặp, không dừng sau bước đọc file.
4. Câu hỏi rộng/mơ hồ (case 2): hỏi làm rõ — không tự mở rộng phạm vi tra cứu.
5. User kèm URL/path màn hình → ưu tiên map route → mô tả logic tại màn đó.

## 2. Chuẩn xác — bám sát sản phẩm thật (BẮT BUỘC)
- Mọi tên nút / menu / ô nhập / thông báo phải khớp 100% chữ trên UI (locale \`vi\`). **Không thấy bằng chứng thì nói "chưa tìm thấy trên hệ thống" — tuyệt đối không bịa.**
- Không tự đặt tên màn hình/tính năng không tồn tại. Không suy diễn hành vi ngoài những gì source/docs thể hiện.
- Thứ tự nguồn tra cứu: (a) \`**/locales/vi*.json\`, \`**/i18n/**/vi*\`, \`**/lang/**\` → (b) component/view giao diện (template, label, title) → (c) docs/config trong repo.
- Tránh jargon kỹ thuật (API, class, commit…) trừ khi người dùng chủ động hỏi kỹ thuật; ưu tiên ngôn ngữ thao tác của người dùng cuối.

## 3. Ranh giới workspace (CHỈ ĐỌC — BẮT BUỘC)
${baReadOnlyWorkspaceRules({ mainBranch: opts.mainBranch })}
${baGitlabBoundaryInstructions()}

${dbBlock}

${baDeliverAnswerRules()}

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

${opts.workflowBlock ? `${opts.workflowBlock}\n\n` : ""}${opts.historyBlock ? `## Hội thoại trước\n${opts.historyBlock}\n` : ""}${opts.gitlabTaskBlock ? `${opts.gitlabTaskBlock}\n\n` : ""}## Câu hỏi
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
  workflowBlock?: string;
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
    const googleAccessToken = await resolveBaUserGoogleAccessToken(opts.userId);
    const linked = await loadBaLinkedContext({
      gitlabHost: project.gitlabHost,
      gitlabPath: project.gitlabPath,
      gitlabToken,
      googleAccessToken,
      texts: [opts.question, ...historyUserTexts],
    });
    session.check();
    if (linked.progressLabel) {
      publishBaProgress({
        userId: opts.userId,
        threadId: opts.threadId,
        messageId: opts.assistantMessageId,
        step: "read",
        label: linked.progressLabel,
      });
    }

    const prompt = buildBaPrompt({
      displayName: project.displayName,
      gitlabPath: project.gitlabPath,
      mainBranch: project.mainBranch || "main",
      historyBlock,
      gitlabTaskBlock: linked.block,
      question: opts.question,
      analysisMode: Boolean(opts.analysisMode),
      workflowBlock: opts.workflowBlock,
      dbAccess,
    });

    logger.info("BA chat agent starting", {
      threadId: opts.threadId,
      projectId: opts.baProjectId,
      model: modelId,
      analysisMode: Boolean(opts.analysisMode),
      dbAccess: dbAccess.allowed,
      gitlabIssueIids: linked.gitlabRefs.map((r) => r.iid),
      googleSheets: linked.sheetRefs.length,
      googleDocs: linked.docRefs.length,
      needsGoogleAuth: linked.needsGoogleAuth,
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
          sandboxOptions: { enabled: true },
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
  /** Context YC + Kết quả phân tích (thread gắn workflow). */
  workflowBlock?: string;
  /**
   * Hậu xử lý câu trả lời (vd. áp dụng resultUpdate vào Kết quả phân tích).
   * Trả về nội dung đã làm sạch để lưu/hiển thị, hoặc null nếu giữ nguyên.
   */
  postProcessAnswer?: (answer: string) => Promise<string | null>;
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

      const rawAnswer = await runBaChatAgent({
        userId: opts.userId,
        threadId: opts.threadId,
        baProjectId: opts.baProjectId,
        question: opts.question,
        assistantMessageId: assistantId,
        analysisMode: opts.analysisMode,
        workflowBlock: opts.workflowBlock,
      });

      let answer = rawAnswer;
      if (opts.postProcessAnswer) {
        try {
          const processed = await opts.postProcessAnswer(rawAnswer);
          if (processed?.trim()) answer = processed;
        } catch (err) {
          logger.warn("BA chat postProcessAnswer failed", {
            threadId: opts.threadId,
            err: String(err),
          });
        }
      }

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
