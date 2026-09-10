import { Agent } from "@cursor/sdk";
import { logger } from "../../logger.js";
import {
  getBaProject,
  getBaProjectGitlabToken,
  isBaDbAccessAllowed,
  listBaMessages,
  resolveBaProjectDb,
  resolveSystemCursorApiKey,
  resolveSystemCursorModel,
  resolveSystemCursorModelSpec,
  type BaMessage,
  type BaRequirement,
  type BaRequirementStep,
  type BaWorkflowStepKey,
} from "../../workspace/baStore.js";
import { cursorModelLogLabel } from "../cursor/modelSpec.js";
import { readOnlyAgentPolicy } from "../cursor/agentPolicy.js";
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
  baIntentTriageGate,
  baPresentationRules,
} from "./baChat.js";
import {
  beginCancellableJob,
  errorFromCursorRunStatus,
  isTransientCursorTransportError,
} from "./run.js";
import { persistCursorUsage } from "../cursor/recordUsage.js";

const WORKFLOW_TIMEOUT_MS = 12 * 60 * 1000;

export type ParsedBaTask = {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  /** Ghi chú kỹ thuật cho Dev — tách khỏi mô tả nghiệp vụ. */
  devNotes: string;
};

export type WorkflowStepGate = {
  /** invalid = đầu vào không phải yêu cầu nghiệp vụ (chào hỏi, rác) → dừng hẳn flow. */
  status: "ok" | "blocked" | "invalid";
  openQuestions: string[];
};

const STEP_LABELS: Record<BaWorkflowStepKey, string> = {
  clarify: "Làm rõ yêu cầu",
  asIs: "Hiện trạng sản phẩm",
  toBe: "Phân tích & đề xuất",
  breakdown: "Kết quả phân tích (task)",
};

/**
 * Chặn sớm đầu vào rõ ràng KHÔNG phải yêu cầu nghiệp vụ (chào hỏi, ping, rác)
 * trước khi tốn một lượt agent. Trường hợp mơ hồ tinh vi hơn do gate của
 * bước Làm rõ xử lý.
 */
export function looksLikeGreetingOrNoise(raw: string): boolean {
  const text = raw.trim();
  if (!text) return true;
  // Không có chữ cái nào (chỉ số / ký hiệu / emoji) → rác.
  if (!/\p{L}/u.test(text)) return true;

  const words = text.split(/\s+/).filter(Boolean);
  const greetingWord =
    /^(hi+|hello+|helo|alo+|hey+|yo+|chào|xin|bạn|anh|chị|em|ạ|nhé|test(ing)?|ping|ok(e|ay)?)[.,!?~…]*$/i;
  // Câu ngắn mà mọi từ đều là từ chào / xã giao → không phải yêu cầu.
  if (words.length <= 4 && words.every((w) => greetingWord.test(w))) {
    return true;
  }
  // Quá ngắn để là một yêu cầu (1 từ và dưới 12 ký tự).
  if (words.length < 2 && text.length < 12) return true;
  return false;
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

function formatMessagesBlock(messages: BaMessage[]): string {
  return messages
    .filter((m) => m.content?.trim())
    .map((m) => {
      const who = m.role === "user" ? "Human" : "Assistant";
      return `### ${who}\n${m.content.trim()}`;
    })
    .join("\n\n");
}

/** Detect whether clarify step should pause for BA chat. */
export function parseWorkflowStepGate(
  step: BaWorkflowStepKey,
  content: string,
): WorkflowStepGate {
  if (step !== "clarify") return { status: "ok", openQuestions: [] };

  for (const block of content.match(/```[\s\S]*?```/g) || []) {
    const inner = block.replace(/```(?:json)?/gi, "").replace(/```$/, "").trim();
    const gate = tryParseGateJson(inner);
    if (gate) return softenClarifyGate(gate, content);
  }

  const inline = /\{[\s\S]*"gate"\s*:\s*"(?:ok|blocked|invalid)"[\s\S]*?\}/.exec(content);
  if (inline) {
    const gate = tryParseGateJson(inline[0]);
    if (gate) return softenClarifyGate(gate, content);
  }

  // Heuristic: lấy câu hỏi từ markdown — không bao giờ blocked (tránh
  // "## Cần chốt sau (không chặn…)" bị hiểu là dừng flow).
  const questions: string[] = [];
  let inSection = false;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (/^#{1,3}\s*(câu hỏi|questions?|cần chốt|mơ hồ|giả định)/i.test(t)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,3}\s/.test(t)) break;
    if (inSection && /^[-*]\s+/.test(t)) {
      questions.push(t.replace(/^[-*]\s+/, "").trim());
    }
  }

  return softenClarifyGate(
    { status: "ok", openQuestions: questions },
    content,
  );
}

/**
 * Agent hay ghi "đủ sang Hiện trạng" rồi vẫn xuất gate blocked.
 * Nếu nội dung đã có phân tích thật → coi như ok (câu hỏi chỉ là ghi chú).
 */
function softenClarifyGate(
  gate: WorkflowStepGate,
  content: string,
): WorkflowStepGate {
  if (gate.status !== "blocked") return gate;
  const body = content.replace(/```[\s\S]*?```/g, "");
  const softSignal =
    /không chặn|đủ nền tảng|đủ (rõ |để )?sang|ưu tiên giả định|YC đủ|không dừng flow|chạy tiếp/i.test(
      body,
    );
  const hasRealClarify =
    /IN\s*Scope|OUT\s*Scope|Phạm vi|Tóm tắt yêu cầu/i.test(body) &&
    body.trim().length > 350;
  if (softSignal || hasRealClarify) {
    return { status: "ok", openQuestions: gate.openQuestions };
  }
  return gate;
}

function tryParseGateJson(raw: string): WorkflowStepGate | null {
  try {
    const parsed = JSON.parse(raw) as {
      gate?: string;
      openQuestions?: string[];
    };
    const status: WorkflowStepGate["status"] =
      parsed.gate === "invalid"
        ? "invalid"
        : parsed.gate === "blocked"
          ? "blocked"
          : "ok";
    const openQuestions = (parsed.openQuestions || [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (status === "invalid" && !openQuestions.length) {
      return {
        status: "invalid",
        openQuestions: [
          "Nội dung chưa phải một yêu cầu nghiệp vụ — nhập lại yêu cầu gốc rõ ràng (ai cần gì, để làm gì).",
        ],
      };
    }
    if (status === "blocked" && !openQuestions.length) {
      return { status: "blocked", openQuestions: ["Cần làm rõ thêm trước bước hiện trạng"] };
    }
    return { status, openQuestions };
  } catch {
    return null;
  }
}

function priorStepsBlock(steps: BaRequirementStep[]): string {
  if (!steps.length) return "";
  return steps
    .map((s) => `### ${STEP_LABELS[s.key]}\n${s.content.trim()}`)
    .join("\n\n");
}

/** Người đọc là BA không biết code — mọi output bước phải thuần nghiệp vụ. */
export function baBusinessLanguageRules(): string {
  return `## Ngôn ngữ nghiệp vụ (BẮT BUỘC — người đọc là BA, không biết code)
- Tuyệt đối KHÔNG nhắc tên file, thư mục, hàm, class, biến, key, bảng/cột DB, API endpoint, framework trong nội dung trả lời.
- Diễn đạt hoàn toàn bằng nghiệp vụ: màn hình, nút, luồng thao tác, quy tắc — đúng tên hiển thị trên UI tiếng Việt.
- Chi tiết kỹ thuật hữu ích cho Dev (nếu có) chỉ được đặt vào trường \`devNotes\` của JSON task ở bước Kết quả phân tích — không xuất hiện ở bất kỳ chỗ nào khác.`;
}

function buildWorkflowPrompt(opts: {
  displayName: string;
  gitlabPath: string;
  mainBranch: string;
  step: BaWorkflowStepKey;
  title: string;
  rawContent: string;
  baNote: string;
  priorSteps: BaRequirementStep[];
  gitlabTaskBlock: string;
  threadBlock: string;
  graphifyBlock?: string;
  dbAccess: { allowed: boolean; dialect?: string; database?: string };
}): string {
  const dbBlock = opts.dbAccess.allowed
    ? `Database read-only: ON (${opts.dbAccess.dialect} / ${opts.dbAccess.database}). Chỉ dùng tool query_readonly_* khi cần.`
    : "Database: OFF — không truy vấn DB.";

  const stepInstructions: Record<BaWorkflowStepKey, string> = {
    clarify: `## Nhiệm vụ bước này: LÀM RÕ YÊU CẦU
**Trước hết, thẩm định đầu vào.** Nếu "Yêu cầu gốc" chỉ là lời chào / ping / test / rác không mang nội dung nghiệp vụ (vd: "hi", "xin chào", "test", "123") → KHÔNG phân tích gì cả, trả lời 1 câu mời nhập yêu cầu thật, và gate \`invalid\`.

Nếu là yêu cầu nghiệp vụ thật:
- Tóm tắt yêu cầu gốc (1 đoạn) + điểm BA đã đàm phán/điều chỉnh (nếu có).
- Liệt kê phạm vi IN / OUT.
- Liệt kê câu hỏi / giả định (tối đa 5). **Ưu tiên ghi giả định hợp lý** (vd: "Giả định: chức năng đặt tại màn Danh sách nhân viên") thay vì dừng flow để hỏi.
- Không đề xuất giải pháp chi tiết ở bước này.

**Gate — rất quan trọng (đừng cứng nhắc):**
YC từ PD/khách thường **đủ để chạy tiếp** dù còn vài điểm chưa chốt. Chỉ \`blocked\` khi **không thể** sang Hiện trạng vì thiếu nền tảng:
- Không biết đang nói về chức năng / nghiệp vụ gì (1 cụm từ mơ hồ: "cải thiện hệ thống", "làm đẹp UI"), **hoặc**
- YC tự mâu thuẫn đến mức không phân tích được.

**KHÔNG \`blocked\`** chỉ vì còn hỏi: màn hình cụ thể, danh sách cột file mẫu, phạm vi [NULL], có tạo mới hay không, hình thức báo cáo lỗi… — ghi vào phần câu hỏi/giả định và để \`ok\`. BA sẽ chốt qua chat hoặc chỉnh Kết quả phân tích sau.

**Cuối câu trả lời**, thêm JSON gate (1 dòng):
\`\`\`json
{"gate":"ok","openQuestions":[]}
\`\`\`
- \`invalid\` + lý do trong \`openQuestions\` nếu đầu vào KHÔNG phải yêu cầu nghiệp vụ → flow dừng hẳn.
- \`blocked\` + \`openQuestions\` **chỉ** khi thiếu nền tảng như trên (hiếm).
- \`ok\` trong hầu hết trường hợp yêu cầu có mô tả hành vi / quy tắc — kể cả khi vẫn liệt kê câu hỏi trong phần chữ (không cần nhét hết vào JSON).`,
    asIs: `## Nhiệm vụ bước này: HIỆN TRẠNG
- Mô tả hệ thống ĐANG có gì liên quan (màn hình, nút, luồng — đúng tên UI tiếng Việt).
- Ưu tiên tái sử dụng pattern/màn hình hiện có.
- Không bịa tên UI — nếu chưa tìm thấy thì nói rõ.`,
    toBe: `## Nhiệm vụ bước này: PHÂN TÍCH & ĐỀ XUẤT
- Viết theo **format spec BA** (đúng tên đầu mục khi có nội dung): \`1. Yêu cầu khách hàng\` → \`2. Yêu cầu/Đề xuất từ PD\` (nếu có) → \`3. Nội dung phân tích\` (\`3.1. Màn hình\` / \`3.1.x. Cột\` / \`3.2. Logic xử lý\` / \`3.3. Popup\` khi là màn list/form) → \`4. Câu hỏi cần xác nhận\` (nếu còn).
- Tôn trọng điểm BA đã đàm phán; không pad mục trống; không bịa UI.
- Rủi ro & phụ thuộc ngắn (trong mục 3 hoặc 4).`,
    breakdown: `## Nhiệm vụ bước này: KẾT QUẢ PHÂN TÍCH (TASK)
- Tổng hợp **một** GitLab issue cho **toàn bộ** YC (không chia nhiều task). Đây là "Kết quả phân tích" — trọng tâm mà BA sẽ tiếp tục chỉnh qua chat.
- Title ngắn, rõ (tên chức năng + hành động) — **không** nhồi format spec vào title.
- Description markdown theo đúng đầu mục BA: \`1. Yêu cầu khách hàng\` / \`2. Yêu cầu/Đề xuất từ PD\` (nếu có) / \`3. Nội dung phân tích\` (kèm 3.1–3.3 khi là spec màn hình). **Không** đưa mục 4 lên issue.
- \`acceptanceCriteria\` luôn \`[]\` (schema giữ field).
- \`devNotes\`: ghi chú kỹ thuật NGẮN cho Dev (gợi ý vùng chức năng liên quan, ràng buộc kỹ thuật) — đây là chỗ DUY NHẤT được phép nói kỹ thuật. Không có gì đáng ghi thì để chuỗi rỗng.
- **Không** gán label — để BA chọn sau.

**Cuối câu trả lời**, thêm block JSON (bắt buộc, chỉ 1 block, **một task**):

\`\`\`json
{"task":{"title":"…","description":"…","labels":[],"acceptanceCriteria":[],"devNotes":"…"}}
\`\`\`

JSON phải parse được; không comment trong JSON.`,
  };

  return `Bạn là Business Analyst chuyên nghiệp trên dự án **${opts.displayName}**.

${baIntentTriageGate()}

**Lưu ý workflow YC:** User đã chủ động tạo YC và chạy bước "${STEP_LABELS[opts.step]}" — **bỏ qua case 2 (INSUFFICIENT CONTEXT) của Intent Triage**. Coi như case 3 trừ khi YC chỉ là chào/rác (\`invalid\`) hoặc thật sự trống/mâu thuẫn không phân tích được (\`blocked\`). Câu hỏi làm rõ → ghi giả định + \`ok\`, đừng dừng flow.

${stepInstructions[opts.step]}

${baBusinessLanguageRules()}

${baPresentationRules()}

## Ranh giới
- Chỉ đọc source — không sửa file, commit, MR.
${baGitlabBoundaryInstructions()}
- Branch đọc: ${opts.mainBranch}
${dbBlock}
- Case 3 / cần tra source: gọi tool \`code_map_query\` **trước** Grep.

${opts.graphifyBlock ? `${opts.graphifyBlock}\n\n` : ""}## Yêu cầu gốc (từ khách hàng / PD — nguyên văn)
**Tiêu đề:** ${opts.title}

${opts.rawContent.trim()}

${opts.baNote.trim() ? `## BA phân tích / đàm phán (điều chỉnh so với yêu cầu gốc — ưu tiên khi mâu thuẫn)\n${opts.baNote.trim()}\n\n` : ""}${opts.priorSteps.length ? `## Các bước đã chốt trước\n${priorStepsBlock(opts.priorSteps)}\n` : ""}${opts.threadBlock ? `## Trao đổi làm rõ (chat workflow)\n${opts.threadBlock}\n\n` : ""}${opts.gitlabTaskBlock ? `${opts.gitlabTaskBlock}\n\n` : ""}Viết bằng tiếng Việt, gọn, chuyên nghiệp.`;
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

function parseTaskFields(raw: {
  title?: string;
  description?: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  devNotes?: string;
}): ParsedBaTask | null {
  const title = String(raw.title || "").trim();
  if (!title) return null;
  return {
    title,
    description: String(raw.description || "").trim(),
    labels: (raw.labels || []).map((l) => String(l).trim()).filter(Boolean),
    acceptanceCriteria: (raw.acceptanceCriteria || [])
      .map((s) => String(s).trim())
      .filter(Boolean),
    devNotes: String(raw.devNotes || "").trim(),
  };
}

/** Parse **one** task JSON from workflow step 4 output. */
export function parseTaskFromWorkflowOutput(text: string): ParsedBaTask | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const tryJson = (raw: string): ParsedBaTask | null => {
    try {
      const parsed = JSON.parse(raw) as {
        task?: {
          title?: string;
          description?: string;
          labels?: string[];
          acceptanceCriteria?: string[];
          devNotes?: string;
        };
        tasks?: Array<{
          title?: string;
          description?: string;
          labels?: string[];
          acceptanceCriteria?: string[];
          devNotes?: string;
        }>;
      };
      if (parsed.task) return parseTaskFields(parsed.task);
      const first = parsed.tasks?.[0];
      if (first) return parseTaskFields(first);
    } catch {
      /* ignore */
    }
    return null;
  };

  const fenceStart = trimmed.indexOf("```");
  if (fenceStart >= 0) {
    const afterFence = trimmed.slice(fenceStart + 3).replace(/^json\s*/i, "");
    const fenceEnd = afterFence.indexOf("```");
    const block = fenceEnd >= 0 ? afterFence.slice(0, fenceEnd) : afterFence;
    const task = tryJson(block.trim());
    if (task) return task;
  }

  const inline =
    /\{[\s\S]*"(?:task|tasks)"\s*:/.exec(trimmed);
  if (inline) {
    const task = tryJson(inline[0]);
    if (task) return task;
  }

  return null;
}

/** @deprecated Use parseTaskFromWorkflowOutput — returns 0 or 1 task. */
export function parseTasksFromBreakdown(text: string): ParsedBaTask[] {
  const task = parseTaskFromWorkflowOutput(text);
  return task ? [task] : [];
}

export type BaResultUpdate = {
  title?: string;
  description?: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  devNotes?: string;
};

const RESULT_UPDATE_FENCE_RE =
  /```(?:json)?\s*(\{[\s\S]*?"resultUpdate"[\s\S]*?\})\s*```/i;

function tryParseResultUpdate(raw: string): BaResultUpdate | null {
  try {
    const parsed = JSON.parse(raw) as { resultUpdate?: BaResultUpdate };
    const u = parsed.resultUpdate;
    if (!u || typeof u !== "object") return null;
    const out: BaResultUpdate = {};
    if (typeof u.title === "string" && u.title.trim()) out.title = u.title.trim();
    if (typeof u.description === "string") out.description = u.description.trim();
    if (Array.isArray(u.labels)) {
      out.labels = u.labels.map((l) => String(l).trim()).filter(Boolean);
    }
    if (Array.isArray(u.acceptanceCriteria)) {
      out.acceptanceCriteria = u.acceptanceCriteria
        .map((s) => String(s).trim())
        .filter(Boolean);
    }
    if (typeof u.devNotes === "string") out.devNotes = u.devNotes.trim();
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Parse block cập nhật Kết quả phân tích do chat workflow xuất ra (nếu có). */
export function parseResultUpdateFromChat(text: string): BaResultUpdate | null {
  const fence = RESULT_UPDATE_FENCE_RE.exec(text);
  if (fence) {
    const update = tryParseResultUpdate(fence[1]);
    if (update) return update;
  }
  const inline = /\{[\s\S]*"resultUpdate"\s*:[\s\S]*\}/.exec(text);
  if (inline) return tryParseResultUpdate(inline[0]);
  return null;
}

/** Bỏ block resultUpdate khỏi nội dung chat hiển thị cho BA. */
export function stripResultUpdateBlock(text: string): string {
  return text
    .replace(RESULT_UPDATE_FENCE_RE, "")
    .replace(/\{[\s\S]*"resultUpdate"\s*:[\s\S]*\}\s*$/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function runBaWorkflowStep(opts: {
  baProjectId: string;
  requirement: BaRequirement;
  step: BaWorkflowStepKey;
}): Promise<string> {
  const cancelKey = `ba-wf:${opts.requirement.id}`;
  const session = beginCancellableJob(cancelKey);

  try {
    const project = await getBaProject(opts.baProjectId);
    if (!project) throw new Error("BA project not found");
    if (
      project.cloneStatus !== "ready" ||
      !(await isGitRepo(project.localPath))
    ) {
      throw new Error("Project chưa sẵn sàng — liên hệ admin");
    }

    session.check();
    await pullBaProjectLatest(project);
    session.check();

    await ensureProjectGraphifyReady(project.localPath, { timeoutMs: 90_000 });
    session.check();
    const graphifyQuery = await queryProjectGraphify(
      project.localPath,
      [opts.requirement.title, opts.requirement.rawContent, opts.step].join(
        " | ",
      ),
    );
    const graphifyBlock = formatBaGraphifyPromptBlock({
      sourcePath: project.localPath,
      queryText: graphifyQuery,
    });
    session.check();

    const apiKey = await resolveSystemCursorApiKey();
    const model = await resolveSystemCursorModelSpec();
    const modelLabel = cursorModelLogLabel(await resolveSystemCursorModel());
    const dbAllowed = isBaDbAccessAllowed(project);
    const dbCfg = dbAllowed ? await resolveBaProjectDb(project.id) : null;
    const dbAccess = {
      allowed: Boolean(dbCfg),
      dialect: dbCfg?.dialect,
      database: dbCfg?.database,
    };

    const gitlabToken = await getBaProjectGitlabToken(project.id);
    const googleAccessToken = await resolveBaUserGoogleAccessToken(
      opts.requirement.userId,
    );

    let threadBlock = "";
    let threadUserTexts: string[] = [];
    if (opts.requirement.linkedThreadId) {
      const msgs = await listBaMessages(opts.requirement.linkedThreadId);
      if (msgs.some((m) => m.content?.trim())) {
        threadBlock = formatMessagesBlock(msgs);
      }
      threadUserTexts = msgs
        .filter((m) => m.role === "user" && m.content?.trim())
        .slice(-8)
        .map((m) => m.content.trim());
    }

    const linked = await loadBaLinkedContext({
      gitlabHost: project.gitlabHost,
      gitlabPath: project.gitlabPath,
      gitlabToken,
      googleAccessToken,
      texts: [
        opts.requirement.rawContent,
        opts.requirement.baNote || "",
        opts.requirement.title,
        ...threadUserTexts,
      ],
    });

    const priorSteps = opts.requirement.steps.filter(
      (s) => s.key !== opts.step,
    );

    const prompt = buildWorkflowPrompt({
      displayName: project.displayName,
      gitlabPath: project.gitlabPath,
      mainBranch: project.mainBranch || "main",
      step: opts.step,
      title: opts.requirement.title,
      rawContent: opts.requirement.rawContent,
      baNote: opts.requirement.baNote || "",
      priorSteps,
      gitlabTaskBlock: linked.block,
      threadBlock,
      graphifyBlock,
      dbAccess,
    });

    logger.info("BA workflow step starting", {
      requirementId: opts.requirement.id,
      step: opts.step,
      projectId: project.id,
      gitlabIssueIids: linked.gitlabRefs.map((r) => r.iid),
      googleSheets: linked.sheetRefs.length,
      googleDocs: linked.docRefs.length,
      needsGoogleAuth: linked.needsGoogleAuth,
    });

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
        ...(BA_GITLAB_INTERACTION_ENABLED ? {} : { mcpServers: {} }),
        local: {
          cwd: project.localPath,
          ...(BA_GITLAB_INTERACTION_ENABLED ? {} : { settingSources: [] }),
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
          logger.warn("BA workflow stream error; waiting for result", {
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
          { label: "BA workflow" },
        );
      }

      const fromResult = String(
        (result as { result?: string }).result || "",
      ).trim();
      const finalText = fromResult.length >= streamed.length
        ? fromResult || streamed
        : streamed || fromResult;
      if (!finalText) throw new Error("Agent returned empty content");
      await persistCursorUsage({
        kind: "ba_workflow",
        userId: opts.requirement.userId,
        threadId: opts.requirement.linkedThreadId || undefined,
        requirementId: opts.requirement.id,
        agent: disposed,
        run,
        result,
        promptChars: prompt.length,
        outputChars: finalText.length,
        model: await resolveSystemCursorModel(),
      });
      return finalText;
    };

    return await withTimeout(work(), WORKFLOW_TIMEOUT_MS, "BA workflow step");
  } finally {
    session.end();
  }
}

export { STEP_LABELS as BA_WORKFLOW_STEP_LABELS };
