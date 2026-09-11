import { Agent } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { logger } from "../../logger.js";
import { publishRealtime } from "../realtime/hub.js";
import { getConfig } from "../../config.js";
import {
  beginCancellableJob,
  cancelActiveAgentRun,
  clearJobKillRequested,
  errorFromCursorRunStatus,
  formatCursorAgentFailure,
  hasActiveAgentRun,
  isJobKillRequested,
  isTransientCursorTransportError,
  markCursorTransient,
} from "./run.js";
import { persistCursorUsage } from "../cursor/recordUsage.js";
import { readOnlyAgentPolicy } from "../cursor/agentPolicy.js";
import {
  appendBaMessage,
  getBaProject,
  getBaProjectGitlabToken,
  isBaDbAccessAllowed,
  listBaMessages,
  resolveBaProjectDb,
  resolveSystemCursorApiKey,
  resolveSystemCursorModel,
  resolveSystemCursorModelSpec,
  updateBaMessageContent,
  updateBaThreadTitle,
} from "../../workspace/baStore.js";
import { cursorModelLogLabel } from "../cursor/modelSpec.js";
import { isGitRepo } from "../../workspace/clone.js";
import {
  ensureProjectGraphifyReady,
  formatBaGraphifyPromptBlock,
  queryProjectGraphify,
} from "../../workspace/graphify.js";
import { pullBaProjectLatest } from "../git/ba-pull.js";
import { redactGitCredentials } from "../git/redact.js";
import { buildBaDbCustomTools } from "../baDb/tools.js";
import { mergeBaAgentCustomTools } from "../ba/graphifyTools.js";
import { loadBaLinkedContext } from "../ba/ba-linked-context.js";
import { resolveBaUserGoogleAccessToken } from "../../modules/google/index.js";

/**
 * Temporary gate: BA / PD / QC chat must not call GitLab write APIs
 * (issues, comments, labels, MRs). Local Flow task drafts are still allowed.
 * Flip to `true` when direct GitLab write from chat is ready again.
 */
export const BA_GITLAB_INTERACTION_ENABLED = false;

export function baGitlabBoundaryInstructions(): string {
  if (BA_GITLAB_INTERACTION_ENABLED) {
    return `- Bị yêu cầu sửa code → từ chối lịch sự, gợi ý tạo ticket cho Dev.`;
  }
  return `- Bị yêu cầu sửa code → từ chối lịch sự; nếu cần ticket Dev thì tạo **task nội bộ Flow** (chat BA/QC) hoặc hướng dẫn dùng **Create issue**.
- **GitLab ghi (TẠM CẤM):** không tạo/sửa issue / work item trên GitLab; không comment / note / label / assign / close; không MR; không gọi GitLab API, \`glab\`, MCP GitLab, hay curl/wget tới GitLab. **Không auto đăng lên GitLab.**
- Không đọc hay dùng \`GITLAB_TOKEN\`, PAT, token trong git remote / \`.env\` / biến môi trường.
- **GitLab đọc (được phép):** chỉ khi người dùng dán **link issue** hoặc **#id / issue 123**. Hệ thống đã kéo sẵn vào mục "GitLab task (chỉ đọc)" — dùng block đó, **không** tự gọi GitLab.
- Nếu nhờ đọc task mà chưa có link/#id: hỏi họ dán link hoặc mã issue.
- User muốn **đăng / publish lên GitLab**: hướng dẫn dùng nút **Create issue** trên UI — **không** tự gọi API. **Không** từ chối tạo task nội bộ Flow.`;
}

/** Free BA/QC chat: create local Flow task draft when user asks (no GitLab publish). */
export function baLocalTaskCreateInstructions(): string {
  return `## Tạo task nội bộ Flow (khi user yêu cầu)
Khi user nhờ **tạo task / tạo ticket / lưu task / lên task** (không yêu cầu publish GitLab):
1. Soạn **title** ngắn + **description** markdown mang **đầy đủ nội dung đã phân tích**.
   - Đã có mục 1–3 trong chat → đưa **gần nguyên văn** mục 1–3 vào \`description\` (**bỏ mục 4**). Giữ đầu mục + logic/cột/điều kiện/màn hình đã chốt.
   - Viết **nội dung spec** — không viết nhật ký kiểu "đã mô tả", "đã tìm hiểu", "đã tổng hợp theo chat".
2. **Cuối câu trả lời** xuất đúng **1** block JSON (bắt buộc để hệ thống lưu tab Tasks):
\`\`\`json
{"taskCreate":{"title":"…","description":"…","labels":[],"acceptanceCriteria":[],"devNotes":""}}
\`\`\`
3. Trong message: xác nhận đã tạo task draft — xem tab **Tasks**; muốn lên GitLab thì dùng **Create issue**.
- **Không** từ chối kiểu "đang tạm khóa / không tạo được".
- **Không** xuất \`taskCreate\` nếu user chỉ hỏi đáp / phân tích mà **chưa** nhờ tạo task.
- **Cấm** gọi GitLab để tạo issue — chỉ lưu nội bộ Flow.`;
}

/** Workspace read-only — mọi BA chat (kể cả chat YC workflow). */
export function baReadOnlyWorkspaceRules(opts: { mainBranch: string }): string {
  return `- **Vai trò:** chỉ đọc working tree + DB read-only (nếu bật) để trả lời — **không** thực thi thay đổi nào lên repo hoặc disk.
- **Cấm ghi file (tuyệt đối):** không tạo / sửa / xóa / đổi tên file hay thư mục — kể cả \`.md\`, \`.doc\`, \`.docx\`, spec, export, README, ghi chú tạm. **Không** dùng tool Write / Edit / StrReplace / ApplyPatch / Delete / tạo notebook.
- **Deliverable chỉ trong chat:** mọi spec, tài liệu, draft issue → xuất **nguyên văn trong câu trả lời** để user copy. User nhờ "lưu file", "tạo doc", "export ra file" → **từ chối**, giải thích chat không ghi disk, dán nội dung từ chat.
- **Cấm sửa code:** không patch, refactor, format, sửa config / locale / test.
- **Git (chỉ đọc):** server đã pull branch **${opts.mainBranch}** — **không** checkout / tạo-đổi-xóa nhánh / merge / rebase / reset / stash / tag / commit / push / pull thêm.
- **Shell an toàn:** ưu tiên tool \`code_map_*\`. Shell chỉ khi thật sự cần (cat/head/ls file đã biết path). **Cấm** Grep/rg/find toàn repo trước khi đã gọi \`code_map_query\`. **Cấm** rm, mv, cp, tee, chmod, chown, npm/yarn/pnpm install|run|exec, pip install, curl/wget upload, docker, kubectl apply, migrate, dump.
- **MCP / plugin ghi:** không gọi tool hoặc MCP nào ghi GitLab, Google Drive/Sheets/Docs, filesystem.`;
}

/** Format spec 1–4 — gợi ý dùng chung BA mode phân tích và Create issue draft. */
export function baSpecFormatInstructions(): string {
  return `Trình bày theo **format spec BA** dưới đây (không dùng BRD/SRS cũ). **Đúng tên đầu mục** khi mục đó có nội dung — copy nguyên chữ heading (vd. \`## 1. Yêu cầu khách hàng\`, \`### 3.1. Màn hình …\`). Không đổi tên đầu mục sang cách gọi khác.

**Phân vai rõ ràng:**
- Mục **1–2** = **đầu vào** (YC gốc / vấn đề khách hoặc PD đưa) — trích/tóm tắt từ chat, YC, tài liệu; **không** đưa kết luận hay giải pháp BA vào đây.
- Mục **3** = **kết quả phân tích của BA** — cấu trúc màn hình / cột / logic / popup theo code + locale thật.
- Mục **4** = điểm còn cần chốt với stakeholder — **chỉ khi chat / phân tích**; **không** đưa vào GitLab issue / task khi Create issue.

**UI trong spec:** được mô tả **cấu trúc giao diện** (menu, thanh công cụ, vị trí nút, bảng, popup) theo pattern sản phẩm / source / locale. **Cấm** bịa screenshot, pixel, màu sắc, mockup hình ảnh; **không** yêu cầu user gửi ảnh màn hình.

**Mức tối thiểu:**
- **1. Yêu cầu khách hàng** *(đầu vào)* — nhu cầu nghiệp vụ gốc (1–3 câu); **in đậm** tên danh mục/chức năng chính; giữ sát nguyên ý.
- **2. Yêu cầu/Đề xuất từ PD** *(đầu vào, nếu có)* — giải pháp ở mức màn hình/phân hệ (vd. Bổ sung màn hình X tại phân hệ A > B). **Bỏ qua** nếu chưa có ý PD.

**Khi phân tích / đủ thông tin — thêm phần BA (đúng tên đầu mục):**

### 3. Nội dung phân tích
Mở đầu mục 3: **Màn hình xử lý** — đường dẫn menu đầy đủ (vd. Admin > C&B > Hợp đồng) + URL hệ thống nếu có.

#### 3.1. Màn hình [Tên màn hình]
- Màn hình xử lý / bổ sung menu (nếu có) + mô tả nội dung màn hiển thị.
- **Thanh công cụ** (theo pattern sản phẩm / code, không bịa):
  - Phía trên danh sách — trái / phải: bộ chọn cột, Tạo mới, Hành động, phân trang, Tải lại… (chỉ liệt kê nút/control có bằng chứng).
  - Phía dưới: bảng danh sách.
- **Bảng danh sách** (Markdown GFM):

| STT | Tên trường | Mô tả | Kiểu control |
| --- | --- | --- | --- |
| 1 | Chọn | … | Checkbox |
| 2 | STT | … | Label |
| … | … | … | … |

##### 3.1.x. Cột [Tên cột]
Lặp cho từng cột cần mô tả sâu: dữ liệu hiển thị & định dạng; tìm kiếm/lọc + giá trị lọc; tương tác đặc biệt (Copy, Bỏ lọc, menu 3 chấm, logic theo trạng thái).

#### 3.2. Logic xử lý
Tách từng thao tác thành mục con (Tạo mới, Chỉnh sửa, Kích hoạt, Huỷ kích hoạt, Xoá, Bộ chọn cột, Xử lý nhiều bản ghi, Import/Export…). Mỗi thao tác:

- **Điều kiện:** trạng thái / ràng buộc cho phép thực hiện
- **Thực hiện:** bước hệ thống, popup xác nhận, cập nhật trạng thái / Ngày tạo / Ngày cập nhật, thông báo thành công
- **Lưu ý:** ngoại lệ và thông báo chặn

#### 3.3. Popup "[Tên popup]"
Điều kiện mở (Tạo mới / Chỉnh sửa — tự điền dữ liệu) và số tab. Mỗi tab một bảng trường:

| STT | Tên trường | Mô tả | Kiểu control | Bắt buộc (Y/N) |
| --- | --- | --- | --- | --- |

Kèm validate, quy tắc sinh mã (nếu có), hành vi nút Lưu / Lưu và đóng / Đóng.

### 4. Câu hỏi cần xác nhận (nếu có)
Điểm chưa rõ, giả định đang dùng, người cần xác nhận. Thiếu info → ưu tiên mục 4 thay vì pad mục 3.

**Áp dụng linh hoạt (không pad mục trống):**
- Spec màn hình danh mục / CRUD / list+form → full **3.1** (+ **3.1.x** khi cần) / **3.2** / **3.3** / **4**.
- Chỉ bổ sung logic / Import-Export → có thể chỉ **3.2** (vẫn giữ heading đúng tên).
- Chỉ popup form → có thể chỉ **3.3**.
- Phân tích logic thuần (không list/form) → mục 3 viết heading + bullet theo nghiệp vụ; **không** ép bảng cột giả.
- Chỉ ghi đã chốt hoặc tra được từ source/locale — **không bịa** tên nút / cột / popup.`;
}

/** Văn xuôi mặc định; bảng GFM cho catalog list/popup và ma trận cùng cột. */
export function baPresentationRules(): string {
  return `## Trình bày (tự nhiên — bảng khi cùng cấu trúc cột)
- **Mặc định:** văn xuôi + heading đúng tên đầu mục BA + bullet. Viết như BA nói với stakeholder — **không** ép mọi khối thành bảng.
- **Khi viết spec màn hình:** dùng đúng heading \`1. Yêu cầu khách hàng\` / \`2. Yêu cầu/Đề xuất từ PD\` / \`3. Nội dung phân tích\` / \`3.1. Màn hình …\` / \`3.1.x. Cột …\` / \`3.2. Logic xử lý\` / \`3.3. Popup "…"\` / \`4. Câu hỏi cần xác nhận\`.
- **Dùng bảng Markdown GFM** khi có **nhiều dòng cùng cấu trúc cột**, ví dụ:
  - Bảng danh sách (mục 3.1): \`| STT | Tên trường | Mô tả | Kiểu control |\`
  - Bảng trường popup/tab (mục 3.3): \`| STT | Tên trường | Mô tả | Kiểu control | Bắt buộc (Y/N) |\`
  - Catalog form khác / ma trận bước kiểm tra / so sánh ≥4 mục cùng loại
  Đúng chuẩn: mỗi cột một separator \`| --- | --- |\` — **không** bảng hỏng \`|---|\` một cột hay hàng toàn \`---\`.
- **Cấm nhét vào bảng:** kết luận BA, đề xuất tổng, lưu ý dài, đoạn giải thích nhân quả, mục **Điều kiện / Thực hiện / Lưu ý** của 3.2. Những phần đó: heading + câu hoặc bullet.
- Liệt kê ngắn (≤3 mục) luôn dùng bullet. Ô bảng ngắn; đoạn dài để dưới bảng.`;
}

/** Chỉ dùng khi BA mode BẬT và user hỏi phân tích / spec. */
export function baAnalysisModeInstructions(): string {
  return `## Chế độ: BA mode (BẬT) — chọn cách trả lời theo ý định câu hỏi
Bạn đóng vai Business Analyst giàu kinh nghiệm về sản phẩm này, nhưng **không** ép khung phân tích BA cho mọi câu.

### Câu hỏi thường (dù BA mode bật)
Hỏi đáp / hướng dẫn / "làm sao / ở đâu / nút nào…" → trả lời ngắn gọn, đúng UI tiếng Việt, không dàn ý BA thừa.

### Câu hỏi phân tích (phân tích / spec / đề xuất / đánh giá / viết spec màn hình / popup / logic…)
${baSpecFormatInstructions()}

### Nguyên tắc REUSE
- **Ưu tiên tận dụng cái đã có:** trước khi đề xuất mới, kiểm tra sản phẩm đã có màn hình/luồng/quy tắc tương tự → đề xuất mở rộng/tái dùng.
- **Nhất quán pattern hiện hữu:** tên nút, thanh công cụ, xác nhận, báo lỗi, popup theo cách sản phẩm đang làm (locale + code).
- **Tái dùng kết luận cũ:** kế thừa phân tích đã chốt trong hội thoại — không làm lại từ đầu.
- **Deliverable trong chat:** spec theo đúng đầu mục BA (mục 1–4 / 3.1–3.3 khi có) để dán ticket — **không** tạo file.`;
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

Trước khi scan codebase hoặc sinh bất kỳ BA template nào (In/Out Scope, PRD, draft task…),
hãy phân loại input của user theo 3 nhóm sau. KHÔNG được bỏ qua bước này dù user có vẻ gấp.

---

#### 1. GREETING / CASUAL / NOISE
**Nhận diện:** lời chào, ping, test message, gibberish, emoji đơn lẻ, hoặc câu không mang nội dung nghiệp vụ.
Ví dụ: "hi", "hello", "alo", "test", "...", "123", "ok bạn ơi", "👋"

**Hành động:**
- KHÔNG scan codebase.
- KHÔNG sinh bảng Scope, PRD, risk report.
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

#### 3. FULL BA PIPELINE (Scan code → In/Out Scope → phân tích → draft trong chat)
**Chỉ kích hoạt khi có ĐỦ các điều kiện sau:**
- User cung cấp requirement/feature/bug description có đủ: actor, mục tiêu/hiện tượng, và ít nhất 1 điều kiện hoặc bối cảnh cụ thể.
- HOẶC user ra lệnh phân tích rõ ràng (vd: "/analyze", "phân tích giúp tôi req này", "phân tích tính năng X").
- HOẶC đây là lượt tiếp theo sau khi user đã trả lời đủ câu hỏi làm rõ ở bước 2.

**Hành động:** thực hiện đầy đủ pipeline theo quy trình chuẩn của BA Agent (scan → In/Out Scope → phân tích → deliverable trong chat). Chỉ xuất \`taskCreate\` khi user **nhờ tạo task**; không auto đăng GitLab.

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

/**
 * Claimed while kickBaChatAnswer is in flight (before/after Cursor attach).
 * Closes the race where two POSTs both pass hasActiveAgentRun before either
 * beginCancellableJob registers.
 */
const baAnswerClaimByThread = new Set<string>();

export function isBaAnswerInFlight(threadId: string): boolean {
  return (
    baAnswerClaimByThread.has(threadId) ||
    hasActiveAgentRun(baCancelKey(threadId))
  );
}

function claimBaAnswer(threadId: string): boolean {
  if (isBaAnswerInFlight(threadId)) return false;
  baAnswerClaimByThread.add(threadId);
  return true;
}

function releaseBaAnswer(threadId: string): void {
  baAnswerClaimByThread.delete(threadId);
}

/** Wait until thread has no claim + no active Cursor run (Stop & send). */
export async function waitBaAnswerIdle(
  threadId: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const start = Date.now();
  while (isBaAnswerInFlight(threadId)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 80));
  }
  return true;
}

/** Wait only for Cursor run to untrack (claim may already be held by new kick). */
async function waitBaAgentRunIdle(
  threadId: string,
  timeoutMs = 8_000,
): Promise<boolean> {
  const key = baCancelKey(threadId);
  const start = Date.now();
  while (hasActiveAgentRun(key)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 80));
  }
  return true;
}

/** Claim answer slot for this thread. Caller must release via kick finally / releaseBaAnswerClaim. */
export function tryClaimBaAnswer(threadId: string): boolean {
  return claimBaAnswer(threadId);
}

export function releaseBaAnswerClaim(threadId: string): void {
  releaseBaAnswer(threadId);
}

export async function stopBaThreadAgent(threadId: string): Promise<boolean> {
  return cancelActiveAgentRun(baCancelKey(threadId));
}

setMaxListeners(50);

const BA_TIMEOUT_MS = 10 * 60 * 1000;

/** Wall-clock BA limit — must NOT auto-retry (unlike Cursor transport timeouts). */
function isBaWallClockTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^BA chat timed out after/i.test(msg);
}

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

function buildBaDbPromptBlock(dbAccess: {
  allowed: boolean;
  dialect?: string;
  database?: string;
}): string {
  if (!dbAccess.allowed) {
    return `## 3b. Database (CẤM — project chưa bật DB)
- Không kết nối DB, không chạy SQL/ORM/Mongo, không dùng credential trong \`.env\`, không dump/migrate.
- Nếu người dùng hỏi dữ liệu DB: nói rõ project chưa được admin cấu hình/bật DB tra cứu.`;
  }
  if (dbAccess.dialect === "mongodb") {
    return `## 3b. Database (ĐƯỢC PHÉP — MongoDB read-only, đã cấu hình admin)
- **Chỉ một database:** \`${dbAccess.database || "?"}\` (admin setup). Tool luôn gắn đúng DB này.
- **Cấm tuyệt đối:** chuyển/truy cập DB Mongo khác (kể cả tên tenant kiểu YKKSUB nếu đó là DB khác), \`use\` DB khác, shell \`mongosh\`, credential \`.env\`, tự nối URI.
- Nếu người dùng nói tenant/mã công ty (vd. YKKSUB): **lọc trong cùng DB đã setup** (field tenant/company/org trong collection) — không được hiểu là đổi sang database khác. Không tìm thấy field lọc → nói rõ, hỏi BA/admin; không tự nhảy DB.
- **Đúng entity:** user chỉ mã NV / id / tên cụ thể → query **đúng mã đó**. 0 kết quả → nói **không tìm thấy đúng entity đó** và dừng; **cấm** đổi sang NV/id khác rồi trả lời như thành công. Có thể liệt kê vài bản ghi gần giống **chỉ như ứng viên** để họ chọn.
- Khi cần dữ liệu: **chỉ** tool \`query_readonly_mongo\` với JSON:
  - \`{"op":"listCollections"}\`
  - \`{"op":"find","collection":"…","filter":{}}\`
  - \`{"op":"aggregate","collection":"…","pipeline":[…]}\`
  - \`{"op":"count","collection":"…","filter":{}}\`
- Tool đã được hệ thống gắn sẵn (admin đã bật DB) — **gọi ngay**, không chờ phê duyệt / không nói "tool bị chặn" nếu chưa thử gọi.
- **Cấm:** insert/update/delete, \`$out\`/\`$merge\`, dump; không truyền \`database\`/\`db\` trong JSON.
- Không ghi password/URI vào câu trả lời.`;
  }
  return `## 3b. Database (ĐƯỢC PHÉP — SQL read-only, đã cấu hình admin)
- **Chỉ một database:** \`${dbAccess.database || "?"}\` (${dbAccess.dialect || "sql"}). Connection đã gắn DB này.
- **Cấm tuyệt đối:** \`USE\` DB khác, query \`otherdb.table\`, shell \`mysql\`/\`psql\`, credential \`.env\`.
- Tenant/mã công ty trong câu hỏi → lọc bằng cột trong **cùng** DB đã setup, không đổi database.
- **Đúng entity:** user chỉ mã NV / id / tên cụ thể → query **đúng mã đó**. 0 kết quả → nói **không tìm thấy đúng entity đó** và dừng; **cấm** đổi sang NV/id khác rồi trả lời như thành công. Có thể liệt kê vài bản ghi gần giống **chỉ như ứng viên** để họ chọn.
- Khi cần dữ liệu: **chỉ** tool \`query_readonly_sql\` (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN).
- Tool đã được hệ thống gắn sẵn (admin đã bật DB) — **gọi ngay**, không chờ phê duyệt / không nói "tool bị chặn" nếu chưa thử gọi.
- **Cấm:** INSERT/UPDATE/DELETE/DDL, dump, migrate.
- Không ghi password/URI vào câu trả lời.`;
}

/**
 * Chat thường (BA mode TẮT) — prompt FAW tự chứa đủ (triage + tra cứu + ranh giới + format).
 */
/** BA mode ON — FAW triage + Format Spec BA 1–4 + local taskCreate. */
export function buildBaAnalysisModePrompt(opts: {
  displayName: string;
  gitlabPath: string;
  mainBranch: string;
  historyBlock: string;
  gitlabTaskBlock: string;
  question: string;
  workflowBlock?: string;
  graphifyBlock?: string;
  dbBlock: string;
}): string {
  return `Bạn là trợ lý FAW cho dự án **${opts.displayName}** (Chế độ: BA Mode đang BẬT).

## Vai trò & Định hướng
Bạn đóng vai Business Analyst giàu kinh nghiệm về sản phẩm. Bạn linh hoạt chọn cách phản hồi phù hợp với ngữ cảnh thay vì ép khung tài liệu cho mọi câu hỏi:
- **Câu hỏi thông thường (hỏi đáp/hướng dẫn/tra cứu vị trí nút...):** Trả lời trực diện, ngắn gọn theo đúng UI thực tế, không dùng dàn ý BA.
- **Câu hỏi phân tích/yêu cầu viết spec:** Áp dụng chuẩn **Format Spec BA** (Mục 1, 2, 3, 4).
- **Yêu cầu tạo task nội bộ:** Xuất spec hoàn chỉnh kèm khối JSON \`taskCreate\` ở cuối phản hồi.

---

## 🛑 BƯỚC BẮT BUỘC: PHÂN LOẠI Ý ĐỊNH (INTENT TRIAGE)
Thực hiện triage trước khi quét mã nguồn hoặc sinh bất kỳ template BA nào:

### Nhóm 1: Chào hỏi / Xã giao / Không có nội dung nghiệp vụ
- **Dấu hiệu:** Lời chào, ping, test message, icon đơn lẻ ("hi", "hello", "alo", "test", "...", "👋").
- **Xử lý:**
  - **KHÔNG** tra cứu code hay gọi tool.
  - **KHÔNG** sinh bảng scope, PRD hay tài liệu phân tích.
  - Phản hồi ngắn gọn (1–2 câu) thân thiện và gợi ý người dùng gửi yêu cầu hoặc câu hỏi nghiệp vụ.

### Nhóm 2: Thiếu ngữ cảnh (Insufficient Context)
- **Dấu hiệu:** Câu hỏi quá ngắn (< 10 từ) hoặc từ khóa mơ hồ, thiếu chủ thể, mục tiêu hoặc điều kiện (Ví dụ: "export excel", "fix bug login", "thêm nút lưu").
- **Ngoại lệ:** Không tính là thiếu ngữ cảnh nếu đây là câu trả lời tiếp nối cho câu hỏi trước đó của Agent, hoặc người dùng có gửi kèm log/link/tệp đính kèm.
- **Xử lý:**
  - **KHÔNG** tra cứu diện rộng; **KHÔNG** tự vẽ scope hay suy diễn bừa bãi.
  - Đặt 1–2 câu hỏi trọng tâm để làm rõ: Ai dùng? Xảy ra ở màn hình nào? Điều kiện/kỳ vọng là gì?

### Nhóm 3: Yêu cầu phân tích / Hỏi đáp đầy đủ (Full Pipeline)
- **Dấu hiệu:**
  - Cung cấp đủ thông tin (chủ thể, màn hình/tính năng, hành vi hoặc điều kiện cụ thể).
  - Có lệnh phân tích rõ ràng (Ví dụ: "/analyze", "phân tích tính năng X").
  - Lượt trả lời tiếp nối đã cung cấp đủ thông tin sau bước làm rõ ở Nhóm 2.
- **Xử lý:** Kích hoạt quy trình tra cứu và trả lời theo hướng dẫn bên dưới.

---

## Quy trình tra cứu & Trả lời (Dành cho Nhóm 3)

1. **Ưu tiên hội thoại trước:** Nếu thông tin đã được thống nhất hoặc có sẵn trong lịch sử chat, sử dụng ngay mà không tra cứu lại source.
2. **Quy trình tra cứu codebase (nếu cần):**
   - Bắt buộc gọi tool \`code_map_query\` trước để định vị file. Tuyệt đối không dùng Grep/Glob quét diện rộng ngay từ đầu.
   - **Thứ tự nguồn tin:** \`code_map_query\` → các file ngôn ngữ / đa ngữ (locale) của hệ thống → 1–3 file liên quan theo gợi ý từ code map → tài liệu (docs).
   - Nếu người dùng cung cấp URL hoặc path màn hình (Ví dụ: \`/timekeeping/setting/staff-leave\`): Tra cứu route để tìm component tương ứng và đọc quy tắc nghiệp vụ tại màn hình đó.
3. **Bám sát thực tế sản phẩm:**
   - Mọi tên nút bấm, menu, nhãn trường, thông báo popup phải khớp 100% với giao diện và locale thực tế của hệ thống.
   - Nếu không tìm thấy căn cứ trong source/locale, trả lời rõ ràng: *"Chưa tìm thấy trên hệ thống"* kèm câu hỏi làm rõ; tuyệt đối không tự bịa tên màn hình hoặc logic.
4. **Đi thẳng vào kết quả:**
   - Đưa câu trả lời nghiệp vụ ngay ở câu đầu tiên.
   - Tuyệt đối không kết thúc lượt trả lời bằng các câu hứa hẹn/tường thuật thao tác như: *"Đang tra cứu...", "Sẽ kiểm tra...", "Đang lập kế hoạch..."*.

---

## Format Spec BA (Dành cho câu hỏi phân tích / viết spec)

Trình bày bằng văn bản Markdown tự nhiên kết hợp bảng GFM theo đúng các tiêu đề chuẩn (chỉ xuất các mục có nội dung):

### 1. Yêu cầu khách hàng *(Đầu vào)*
- Tóm tắt nhu cầu nghiệp vụ gốc (1–3 câu); **in đậm** tên danh mục/chức năng chính. Giữ nguyên ý, không đưa giải pháp của BA vào đây.

### 2. Yêu cầu/Đề xuất từ PD *(Đầu vào, nếu có)*
- Đề xuất ở mức màn hình/phân hệ từ Product Designer/Owner. Bỏ qua nếu chưa có.

### 3. Nội dung phân tích *(Kết quả phân tích của BA)*
- **Màn hình xử lý:** Ghi rõ đường dẫn menu đầy đủ (Ví dụ: \`Admin > C&B > Hợp đồng\`) và URL hệ thống (nếu có).

#### 3.1. Màn hình [Tên màn hình] *(Nếu có màn hình danh sách)*
- Mô tả bố cục và thanh công cụ (các nút chức năng: Thêm mới, Bộ lọc, Xuất file... có căn cứ thực tế).
- **Bảng danh sách:** Dùng bảng Markdown chuẩn:
  | STT | Tên trường | Mô tả | Kiểu control |
  | --- | --- | --- | --- |
- **3.1.x. Cột [Tên cột]:** Chỉ mô tả sâu cho cột có logic đặc biệt (định dạng, bộ lọc, tương tác nút/menu 3 chấm).

#### 3.2. Logic xử lý
Chia theo từng hành động nghiệp vụ (Thêm mới, Cập nhật, Xóa, Duyệt, Khóa/Mở khóa, Import/Export...):
- **Điều kiện:** Ràng buộc, trạng thái dữ liệu cho phép thực hiện.
- **Thực hiện:** Trình tự xử lý, popup xác nhận, cập nhật trạng thái/thời gian, thông báo thành công.
- **Lưu ý:** Quy tắc chặn, thông báo lỗi và ngoại lệ.

#### 3.3. Popup "[Tên popup]" *(Nếu có popup/form nhập liệu)*
- Điều kiện mở và danh sách trường thông tin:
  | STT | Tên trường | Mô tả | Kiểu control | Bắt buộc (Y/N) |
  | --- | --- | --- | --- | --- |
- Quy tắc kiểm tra tính hợp lệ (validate), quy tắc sinh mã (nếu có) và hành vi các nút (Lưu, Hủy, Đóng).

### 4. Câu hỏi cần xác nhận *(Chỉ dùng trong phiên trao đổi/chat)*
- Các điểm chưa rõ, giả định đang dùng, hoặc người cần chốt thông tin. Ưu tiên nêu rõ tại đây thay vì tự đoán logic.

---

## Giới hạn môi trường (Workspace Boundaries - CHỈ ĐỌC)

- **Cấm ghi / sửa file:** Tuyệt đối không tạo, sửa, xóa, đổi tên file hay thư mục trên ổ đĩa. Mọi kết quả, spec hay tài liệu đều phải xuất trực tiếp trong nội dung chat. Từ chối lịch sự nếu người dùng yêu cầu xuất file hay ghi ra disk.
- **Cấm sửa code / can thiệp Git:** Không tạo branch, sửa code, commit, push, rebase hoặc chạy các lệnh can thiệp repository. Nhánh hiện tại là **${opts.mainBranch}** ở chế độ chỉ đọc.
- **Quyền hạn GitLab (Chỉ đọc qua hệ thống):**
  - Tạm cấm ghi: Không gọi API/MCP/CLI để tạo issue, sửa task, đăng bình luận hay gán label lên GitLab. Nếu người dùng muốn đưa lên GitLab, hướng dẫn họ dùng nút **Create issue** trên giao diện hoặc dán bản draft từ chat.
  - Đọc task: Chỉ đọc nội dung GitLab đã được nạp sẵn trong khối "GitLab task (chỉ đọc)" khi người dùng gửi link/ID issue. Không tự gọi công cụ ngoài để đọc nếu chưa được nạp.
- **Lệnh hệ thống an toàn:** Chỉ dùng các thao tác đọc nhẹ (\`cat\`, \`head\`, \`ls\`) khi đã rõ đường dẫn cụ thể. Không chạy các lệnh cài đặt package, build, deploy, curl/wget hoặc lệnh phá hủy hệ thống.

---

## Tạo task nội bộ Flow (Khi người dùng yêu cầu)

Khi người dùng yêu cầu **tạo task / lưu ticket / lên task** (lưu ý: không phải publish trực tiếp lên GitLab):
1. Soạn nội dung phân tích chi tiết:
   - Đưa nội dung các mục 1, 2, 3 đã chốt vào \`description\` (dùng format Markdown chuẩn).
   - **BỎ HẲN Mục 4 (Câu hỏi cần xác nhận)** khi tạo task. Các điểm đã thống nhất phải được gộp thẳng vào Mục 1, 2 hoặc 3.
   - Không viết câu tường thuật nhật ký (như: "đã mô tả", "đã tìm hiểu", "xem chi tiết ở trên").
2. **Cuối câu trả lời**, xuất **DUY NHẤT một khối JSON** theo đúng định dạng sau để hệ thống tự động lưu vào tab Tasks:

\`\`\`json
{
  "taskCreate": {
    "title": "[Tên ngắn gọn, rõ ràng của chức năng/tác vụ đã chốt]",
    "description": "[Toàn bộ nội dung spec Markdown gồm Mục 1, 2, 3 đã chốt]",
    "labels": [],
    "acceptanceCriteria": [],
    "devNotes": ""
  }
}
\`\`\`
3. Trong message: xác nhận đã tạo task draft — xem tab **Tasks**; muốn lên GitLab thì dùng **Create issue**.
- **Không** từ chối kiểu "đang tạm khóa / không tạo được".
- **Không** xuất \`taskCreate\` nếu user chỉ hỏi đáp / phân tích mà **chưa** nhờ tạo task.
- **Cấm** gọi GitLab để tạo issue — chỉ lưu nội bộ Flow.

---

## Thông tin dự án
- **Dự án:** ${opts.displayName}
- **GitLab Repository:** ${opts.gitlabPath}
- **Branch (Read-only):** ${opts.mainBranch}

${opts.dbBlock}

${opts.graphifyBlock ? `${opts.graphifyBlock}\n\n` : ""}${opts.workflowBlock ? `${opts.workflowBlock}\n\n` : ""}## Hội thoại trước
${opts.historyBlock || "(Chưa có)"}

${opts.gitlabTaskBlock ? `${opts.gitlabTaskBlock}\n\n` : ""}## Câu hỏi của người dùng
${opts.question}`;
}

/** BA mode OFF — FAW triage + Q&A; Spec chi tiết chỉ ở BA mode (analysis). */
export function buildBaNormalChatPrompt(opts: {
  displayName: string;
  gitlabPath: string;
  mainBranch: string;
  historyBlock: string;
  gitlabTaskBlock: string;
  question: string;
  workflowBlock?: string;
  graphifyBlock?: string;
  dbBlock: string;
}): string {
  return `Bạn là trợ lý FAW cho dự án **${opts.displayName}**.

## Mục tiêu & Vai trò
- Giải thích hành vi sản phẩm, luồng thao tác, quy tắc nghiệp vụ theo đúng UI thực tế của hệ thống.
- Vào thẳng nội dung câu trả lời; diễn đạt tự nhiên theo ngôn ngữ nghiệp vụ của người dùng cuối, tránh dùng thuật ngữ kỹ thuật trừ khi người dùng chủ động yêu cầu.
- Không ép khung phân tích đầy đủ mục 1–4 / 3.1–3.3 — đó dành cho chat **bật BA mode**. Khi cần nêu cấu trúc màn hình, dùng quy tắc trình bày bên dưới.

---

## 🛑 BƯỚC BẮT BUỘC: PHÂN LOẠI Ý ĐỊNH (INTENT TRIAGE)
Thực hiện triage ngay trên tin nhắn của người dùng trước khi gọi bất kỳ công cụ tra cứu hay xuất template tài liệu nào:

### Nhóm 1: Chào hỏi / Xã giao / Không có nội dung nghiệp vụ
- **Dấu hiệu:** Lời chào, ping, test message, icon đơn lẻ hoặc từ ngữ vô nghĩa ("hi", "alo", "test", "...", "👋").
- **Xử lý:**
  - **KHÔNG** tra cứu code hay gọi tool.
  - **KHÔNG** sinh bảng scope, PRD hay tài liệu phân tích.
  - Phản hồi ngắn gọn (1–2 câu) lịch sự và gợi ý người dùng gửi yêu cầu hoặc câu hỏi cần hỗ trợ.

### Nhóm 2: Thiếu ngữ cảnh (Insufficient Context)
- **Dấu hiệu:** Câu hỏi quá ngắn (< 10 từ) hoặc từ khóa mơ hồ, thiếu chủ thể, mục tiêu hoặc điều kiện (Ví dụ: "export excel", "fix bug login", "thêm nút lưu").
- **Ngoại lệ:** Không tính là thiếu ngữ cảnh nếu đây là câu trả lời tiếp nối cho câu hỏi trước đó của Agent, hoặc người dùng có gửi kèm log/link/tệp đính kèm.
- **Xử lý:**
  - **KHÔNG** tra cứu sâu toàn hệ thống; **KHÔNG** tự vẽ scope hay suy diễn bừa bãi.
  - Đặt 1–2 câu hỏi trọng tâm để làm rõ: Ai dùng? Xảy ra ở bước/màn hình nào? Kỳ vọng điều gì?

### Nhóm 3: Yêu cầu phân tích / Hỏi đáp đầy đủ (Full Pipeline)
- **Dấu hiệu:**
  - Cung cấp đủ thông tin (chủ thể, màn hình/tính năng, hành vi hoặc điều kiện cụ thể).
  - Có lệnh phân tích rõ ràng (Ví dụ: "/analyze", "phân tích tính năng X").
  - Lượt trả lời tiếp nối đã cung cấp đủ thông tin theo yêu cầu làm rõ ở Nhóm 2.
- **Xử lý:** Kích hoạt quy trình tra cứu và trả lời theo hướng dẫn bên dưới.

---

## Nguyên tắc tra cứu & Phản hồi (Dành cho Nhóm 3)

1. **Ưu tiên ngữ cảnh sẵn có:** Đọc mục "Hội thoại trước". Nếu thông tin đã được thống nhất hoặc đã có trong chat, sử dụng ngay mà không tra cứu lại.
2. **Quy trình tra cứu source code (nếu cần):**
   - Bắt buộc dùng tool \`code_map_query\` trước để định vị file. Tuyệt đối không dùng Grep/Glob quét diện rộng ngay từ đầu.
   - **Thứ tự nguồn tin:** \`code_map_query\` → các file ngôn ngữ / đa ngữ (locale) của hệ thống → 1–3 file liên quan theo gợi ý từ code map → tài liệu (docs).
   - Nếu người dùng cung cấp URL hoặc path màn hình (Ví dụ: \`/timekeeping/setting/staff-leave\`): Tra cứu route để tìm component tương ứng và đọc quy tắc nghiệp vụ tại màn hình đó.
3. **Bám sát thực tế sản phẩm:**
   - Mọi tên nút bấm, menu, nhãn trường, thông báo popup phải khớp 100% với giao diện và locale thực tế của hệ thống.
   - Nếu không tìm thấy căn cứ trong source/locale, trả lời rõ ràng: *"Chưa tìm thấy trên hệ thống"* kèm câu hỏi làm rõ; tuyệt đối không tự bịa tên màn hình hoặc logic.
4. **Trả lời dứt khoát, đi thẳng vào kết quả:**
   - Đưa câu trả lời nghiệp vụ ngay ở câu đầu tiên.
   - Tuyệt đối không kết thúc lượt trả lời bằng các câu hứa hẹn/tường thuật thao tác như: *"Đang tra cứu...", "Sẽ kiểm tra...", "Đang lập kế hoạch..."*.

---

## Giới hạn môi trường (Workspace Boundaries - CHỈ ĐỌC)

- **Cấm ghi / sửa file:** Tuyệt đối không tạo, sửa, xóa, đổi tên file hay thư mục trên ổ đĩa. Mọi kết quả, spec hay tài liệu đều phải xuất trực tiếp trong nội dung chat. Từ chối lịch sự nếu người dùng yêu cầu xuất file hay ghi ra disk.
- **Cấm sửa code / can thiệp Git:** Không tạo branch, sửa code, commit, push, rebase hoặc chạy các lệnh can thiệp repository. Nhánh hiện tại là **${opts.mainBranch}** ở chế độ chỉ đọc.
- **Quyền hạn GitLab (Chỉ đọc qua hệ thống):**
  - Tạm cấm ghi: Không gọi API/MCP/CLI để tạo issue, sửa task, đăng bình luận hay gán label lên GitLab. Nếu người dùng cần ticket GitLab, soạn draft trong chat hoặc dùng **Create issue** trên UI — **không** tự gọi API.
  - Đọc task: Chỉ đọc nội dung GitLab đã được nạp sẵn trong khối "GitLab task (chỉ đọc)" khi người dùng gửi link/ID issue. Không tự gọi công cụ ngoài để đọc nếu chưa được nạp.
- **Lệnh hệ thống an toàn:** Chỉ dùng các thao tác đọc nhẹ (\`cat\`, \`head\`, \`ls\`) khi đã rõ đường dẫn cụ thể. Không chạy các lệnh cài đặt package, build, deploy, curl/wget hoặc lệnh phá hủy hệ thống.

${baLocalTaskCreateInstructions()}

---

${baPresentationRules()}

---

## Thông tin dự án
- **Dự án:** ${opts.displayName}
- **GitLab Repository:** ${opts.gitlabPath}
- **Branch (Read-only):** ${opts.mainBranch}

${opts.dbBlock}

${opts.graphifyBlock ? `${opts.graphifyBlock}\n\n` : ""}${opts.workflowBlock ? `${opts.workflowBlock}\n\n` : ""}## Hội thoại trước
${opts.historyBlock || "(Chưa có)"}

${opts.gitlabTaskBlock ? `${opts.gitlabTaskBlock}\n\n` : ""}## Câu hỏi của người dùng
${opts.question}`;
}

/** BA / PM / QC non-tech assistant — UI + locale vi terminology, no code changes. */
export function buildBaPrompt(opts: {
  displayName: string;
  gitlabPath: string;
  mainBranch: string;
  historyBlock: string;
  gitlabTaskBlock: string;
  question: string;
  analysisMode: boolean;
  /** Context YC + Kết quả phân tích khi thread gắn với workflow YC. */
  workflowBlock?: string;
  /** WorkBench graphify map (sibling graphify-out) */
  graphifyBlock?: string;
  dbAccess: {
    allowed: boolean;
    dialect?: string;
    database?: string;
  };
}): string {
  const dbBlock = buildBaDbPromptBlock(opts.dbAccess);

  const shared = {
    displayName: opts.displayName,
    gitlabPath: opts.gitlabPath,
    mainBranch: opts.mainBranch,
    historyBlock: opts.historyBlock,
    gitlabTaskBlock: opts.gitlabTaskBlock,
    question: opts.question,
    workflowBlock: opts.workflowBlock,
    graphifyBlock: opts.graphifyBlock,
    dbBlock,
  };

  if (!opts.analysisMode) {
    return buildBaNormalChatPrompt(shared);
  }

  return buildBaAnalysisModePrompt(shared);
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
        `Không kéo được code mới nhất (git pull): ${redactGitCredentials(msg)}`,
      );
    }
    session.check();

    const apiKey = await resolveSystemCursorApiKey();
    const model = await resolveSystemCursorModelSpec();
    const modelLabel = cursorModelLogLabel(await resolveSystemCursorModel());

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

    publishBaProgress({
      userId: opts.userId,
      threadId: opts.threadId,
      messageId: opts.assistantMessageId,
      step: "read",
      label: "Đang chuẩn bị code map (graphify)…",
    });
    await ensureProjectGraphifyReady(project.localPath, { timeoutMs: 90_000 });
    session.check();
    const graphifyQuery = await queryProjectGraphify(
      project.localPath,
      [opts.question, ...historyUserTexts.slice(-3)].join(" | "),
    );
    const graphifyBlock = formatBaGraphifyPromptBlock({
      sourcePath: project.localPath,
      queryText: graphifyQuery,
    });
    session.check();

    const prompt = buildBaPrompt({
      displayName: project.displayName,
      gitlabPath: project.gitlabPath,
      mainBranch: project.mainBranch || "main",
      historyBlock,
      gitlabTaskBlock: linked.block,
      question: opts.question,
      analysisMode: Boolean(opts.analysisMode),
      workflowBlock: opts.workflowBlock,
      graphifyBlock,
      dbAccess,
    });

    logger.info("BA chat agent starting", {
      threadId: opts.threadId,
      projectId: opts.baProjectId,
      model: modelLabel,
      analysisMode: Boolean(opts.analysisMode),
      dbAccess: dbAccess.allowed,
      graphifyChars: graphifyQuery?.length ?? 0,
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
      detail: dbAccess.allowed ? `${modelLabel} · DB ON` : modelLabel,
    });

    // Prep (git/graphify/linked) runs once; only Cursor Agent.create+stream retries.
    const work = async (): Promise<string> => {
      session.check();
      const customTools = mergeBaAgentCustomTools(
        project.localPath,
        dbCfg ? (buildBaDbCustomTools(dbCfg) as never) : null,
      );
      const agent = await Agent.create({
        apiKey,
        model,
        ...readOnlyAgentPolicy(),
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
          // Không bật sandboxOptions: customTools đi qua MCP custom-user-tools;
          // sandbox headless chặn phê duyệt → agent báo "tool bị chặn".
          ...(Object.keys(customTools).length
            ? { customTools: customTools as never }
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
      let lastFlushedToDb = "";
      let dbFlushTimer: ReturnType<typeof setTimeout> | undefined;
      let dbFlushChain: Promise<void> = Promise.resolve();

      const flushStreamToDb = (text: string, force = false) => {
        const body = text;
        if (!body.trim()) {
          if (force && dbFlushTimer) {
            clearTimeout(dbFlushTimer);
            dbFlushTimer = undefined;
          }
          return;
        }
        const runFlush = (snapshot: string) => {
          dbFlushTimer = undefined;
          if (!snapshot.trim() || snapshot === lastFlushedToDb) return;
          lastFlushedToDb = snapshot;
          dbFlushChain = dbFlushChain
            .then(() =>
              updateBaMessageContent(opts.assistantMessageId, snapshot, {
                streamStatus: "streaming",
              }),
            )
            .catch((flushErr) => {
              logger.warn("BA mid-stream DB flush failed", {
                messageId: opts.assistantMessageId,
                err:
                  flushErr instanceof Error
                    ? flushErr.message
                    : String(flushErr),
              });
            });
        };
        if (force) {
          if (dbFlushTimer) clearTimeout(dbFlushTimer);
          runFlush(body);
          return;
        }
        // Throttle DB writes (~0.8s) — SSE still goes out every delta.
        if (dbFlushTimer) return;
        dbFlushTimer = setTimeout(
          () => runFlush(streamed || lastPublished),
          800,
        );
      };

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
              flushStreamToDb(streamed);
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

      await persistCursorUsage({
        kind: "ba_chat",
        userId: opts.userId,
        threadId: opts.threadId,
        messageId: opts.assistantMessageId,
        agent: disposed,
        run,
        result,
        promptChars: prompt.length,
        outputChars: finalText.length,
        model: await resolveSystemCursorModel(),
      });

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

      flushStreamToDb(finalText, true);
      await dbFlushChain;
      return finalText;
    };

    // Same policy as /work (`queue.runAgentWithRetry`): Cursor cut / transport
    // flakes retry up to AGENT_TRANSIENT_RETRIES. BA wall-clock timeout does not.
    const maxRetries = Math.max(0, getConfig().AGENT_TRANSIENT_RETRIES);
    let attempt = 0;
    while (true) {
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

        const canRetry =
          isTransientCursorTransportError(err) &&
          !isBaWallClockTimeout(err) &&
          attempt < maxRetries &&
          !isJobKillRequested(cancelKey);

        if (!canRetry) {
          let failMsg = formatCursorAgentFailure(
            err,
            err instanceof Error ? err.message : String(err),
          );
          if (
            isTransientCursorTransportError(err) &&
            !isBaWallClockTimeout(err) &&
            attempt >= maxRetries &&
            maxRetries > 0
          ) {
            failMsg = `${failMsg.replace(/\s*$/, "")} Đã hết lượt tự thử lại — hãy Gửi lại.`;
          }
          const wrapped = new Error(failMsg);
          if (
            isTransientCursorTransportError(err) &&
            !isBaWallClockTimeout(err)
          ) {
            markCursorTransient(wrapped);
          }
          throw wrapped;
        }

        attempt += 1;
        const delayMs = attempt * 5000;
        publishBaProgress({
          userId: opts.userId,
          threadId: opts.threadId,
          messageId: opts.assistantMessageId,
          step: "start",
          label: `Lỗi mạng Cursor tạm thời — tự retry ${attempt}/${maxRetries} sau ${delayMs / 1000}s`,
          detail: raw.slice(0, 120),
        });
        logger.warn("BA chat transient Cursor error — retrying", {
          threadId: opts.threadId,
          attempt,
          maxRetries,
          err: raw,
        });

        // Wipe partial so the next attempt does not append onto stale deltas.
        try {
          await updateBaMessageContent(opts.assistantMessageId, "", {
            streamStatus: "streaming",
          });
        } catch {
          /* best-effort */
        }
        publishRealtime({
          type: "ba_message",
          userId: opts.userId,
          threadId: opts.threadId,
          resetStream: true,
          message: {
            id: opts.assistantMessageId,
            threadId: opts.threadId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
          },
        });

        await new Promise((r) => setTimeout(r, delayMs));
        try {
          session.check();
        } catch (stopErr) {
          const stopMsg =
            stopErr instanceof Error ? stopErr.message : String(stopErr);
          if (/Force-stopped|cancelled/i.test(stopMsg)) {
            throw new Error("Force-stopped from UI");
          }
          throw stopErr;
        }
      }
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
  const cancelKey = baCancelKey(opts.threadId);
  const assistantId = `bam_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  void (async () => {
    try {
      // Stop & send: cancel leftover run, wait for untrack, then clear kill so
      // the new run is not immediately aborted. Generation check also supersedes.
      if (hasActiveAgentRun(cancelKey) || isJobKillRequested(cancelKey)) {
        await cancelActiveAgentRun(cancelKey);
        await waitBaAgentRunIdle(opts.threadId, 8_000);
      }
      clearJobKillRequested(cancelKey);

      const placeholder = await appendBaMessage({
        id: assistantId,
        threadId: opts.threadId,
        role: "assistant",
        content: "",
        streamStatus: "streaming",
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

      await updateBaMessageContent(assistantId, answer, {
        streamStatus: "done",
      });
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
          ? existing.includes("⚠️")
            ? existing
            : `${existing}\n\n⚠️ ${msg}`
          : `⚠️ ${msg}`;

      try {
        await updateBaMessageContent(assistantId, body, {
          streamStatus: stopped ? "done" : "error",
        });
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
    } finally {
      releaseBaAnswer(opts.threadId);
    }
  })();
}
