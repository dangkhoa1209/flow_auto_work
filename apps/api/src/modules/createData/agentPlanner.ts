import { Agent } from "@cursor/sdk";
import { logger } from "../../logger.js";
import { publishRealtime } from "../../plugins/realtime/hub.js";
import { getConfig } from "../../config.js";
import {
  beginCancellableJob,
  cancelActiveAgentRun,
  clearJobKillRequested,
  errorFromCursorRunStatus,
  isJobKillRequested,
  isTransientCursorTransportError,
} from "../../plugins/agent/run.js";
import { persistCursorUsage } from "../../plugins/cursor/recordUsage.js";
import { readOnlyAgentPolicy } from "../../plugins/cursor/agentPolicy.js";
import {
  getBaProject,
  isBaCreateDataDbAccessAllowed,
  isBaDbAccessAllowed,
  resolveBaCreateDataDb,
  resolveBaProjectDb,
  resolveSystemCursorApiKey,
  resolveSystemCursorModel,
  resolveSystemCursorModelSpec,
  toPublicBaCreateData,
  getBaProjectGitlabToken,
} from "../../workspace/baStore.js";
import { cursorModelLogLabel } from "../../plugins/cursor/modelSpec.js";
import { isGitRepo } from "../../workspace/clone.js";
import {
  ensureProjectGraphifyReady,
  formatBaGraphifyPromptBlock,
  queryProjectGraphify,
} from "../../workspace/graphify.js";
import { pullBaProjectLatest } from "../../plugins/git/ba-pull.js";
import { redactGitCredentials } from "../../plugins/git/redact.js";
import { loadBaGitlabTaskBlock } from "../../plugins/gitlab/ba-issue-read.js";
import { buildBaDbCustomTools } from "../../plugins/baDb/tools.js";
import {
  formatQueryResultForAgent,
  runBaReadonlyQuery,
} from "../../plugins/baDb/query.js";
import { withBaDbResolvedConnection } from "../../plugins/baDb/withTunnel.js";
import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import { mergeBaAgentCustomTools } from "../../plugins/ba/graphifyTools.js";
import { buildSeedPlan, assertPlanEntityAlignment } from "./planner.js";
import { parseSeedPlanFromAgent } from "./parsePlan.js";
import type {
  CreateDataEnvironment,
  CreateDataPlanResponse,
} from "./types.js";
import {
  CREATE_DATA_KNOWLEDGE_DEFAULTS,
  applySideEffectValidation,
  buildProposeSeedKnowledgeTool,
  detectCreateDataScope,
  formatKnowledgePromptBlock,
  getCreateDataKnowledge,
  readProjectHeadSha,
  type CreateDataPlanMetrics,
} from "./knowledge/index.js";

const PLAN_TIMEOUT_MS = 10 * 60 * 1000;

function cancelKey(userId: string, baProjectId: string): string {
  return `create_data_plan:${userId}:${baProjectId}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${Math.round(ms / 1000)}s — try a shorter scenario`,
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
  name?: string;
  args?: unknown;
  status?: string;
}): { text: string; toolLabel?: string } {
  if (message.type === "tool_call" && message.name) {
    const argHint =
      message.args && typeof message.args === "object"
        ? Object.values(message.args as Record<string, unknown>)
            .map((v) => String(v || ""))
            .find((s) => s.trim())
            ?.slice(0, 80)
        : "";
    const suffix =
      message.status === "running"
        ? "…"
        : message.status === "error"
          ? " ✗"
          : " ✓";
    return {
      text: "",
      toolLabel: `${message.name}${argHint ? `: ${argHint}` : ""}${suffix}`,
    };
  }
  if (message.type !== "assistant") return { text: "" };
  let text = "";
  for (const block of message.message?.content || []) {
    if (block.type === "text" && block.text) text += block.text;
  }
  return { text };
}

function publishProgress(opts: {
  userId: string;
  baProjectId: string;
  step: "pull" | "start" | "read" | "tool" | "write" | "done" | "error";
  label: string;
  detail?: string;
  plan?: CreateDataPlanResponse & { planner: "ai" | "heuristic" };
}) {
  publishRealtime({
    type: "create_data_progress",
    userId: opts.userId,
    baProjectId: opts.baProjectId,
    step: opts.step,
    label: opts.label,
    detail: opts.detail,
    ...(opts.plan
      ? {
          plan: {
            steps: opts.plan.steps,
            questions: opts.plan.questions,
            notes: opts.plan.notes,
            planner: opts.plan.planner,
          },
        }
      : {}),
  });
}

const REFINE_PLAN_MAX_CHARS = 8_000;

function buildRefineBlock(opts: {
  followUp: string;
  previousPlan: { steps: unknown[]; questions: string[]; notes: string[] };
}): string {
  const prevJson = JSON.stringify(
    { steps: opts.previousPlan.steps, questions: opts.previousPlan.questions },
    null,
    1,
  ).slice(0, REFINE_PLAN_MAX_CHARS);
  return `
## Refine (lượt tiếp theo của cùng scenario — KHÔNG phải plan mới từ đầu)
Plan ngay trước đó (cùng scenario, cùng DB):
\`\`\`json
${prevJson}
\`\`\`

Phản hồi bổ sung của người dùng cho lượt này:
"${opts.followUp}"

Nhiệm vụ refine:
- Cập nhật plan trên theo phản hồi bổ sung — KHÔNG trace lại từ đầu.
- Giữ nguyên step/giá trị đã hợp lệ, đặc biệt các **literal FK id đã resolve** — không re-query phần không đổi.
- Chỉ kiểm tra lại validate cho phần bị ảnh hưởng bởi phản hồi; nếu phản hồi giải quyết được question cũ thì bỏ question đó và sinh steps.
- Nếu phản hồi vẫn chưa đủ/vẫn vi phạm validate → cập nhật questions (ngôn ngữ tự nhiên như quy định).
- Output vẫn đầy đủ: prose + 1 JSON block plan HOÀN CHỈNH (toàn bộ steps, không chỉ phần sửa).
`;
}

function buildSeedPlannerPrompt(opts: {
  displayName: string;
  mainBranch: string;
  prompt: string;
  environment: CreateDataEnvironment;
  seedNotes: string | null;
  dbAccess: {
    allowed: boolean;
    dialect?: string;
    database?: string;
    host?: string;
  };
  graphifyBlock: string;
  gitlabTaskBlock?: string;
  knowledgeBlock?: string;
  refineBlock?: string;
}): string {
  const schemaSourceBlock = opts.dbAccess.allowed
    ? `- Connect DB ON (**${opts.dbAccess.dialect}**, database \`${opts.dbAccess.database}\`): dùng query_* (đọc) để xác nhận schema/FK/mẫu dữ liệu thật trước khi viết step. Kết nối do server quản lý — không cần/không có host, port hay credentials.`
    : `- Connect DB OFF: ghi rõ trong notes rằng schema được suy ra từ source, không xác nhận qua DB thật.`;

  const notesLine = opts.seedNotes
    ? `\nGhi chú seed (admin): ${opts.seedNotes}\n`
    : "";

  return `Bạn là Seed Data Planner cho project ${opts.displayName} (branch ${opts.mainBranch}).

## Giai đoạn hiện tại: PLAN (read-only)
- Chỉ đọc source + DB (nếu Connect DB bật, chỉ dùng tool query_* ở chế độ đọc).
- KHÔNG sửa file, KHÔNG commit/push, KHÔNG ghi DB trong giai đoạn này.
- Deliverable duy nhất: 1 JSON plan trong chat, không ghi ra disk.
- Việc ghi DB thật (insert/update/delete) chỉ diễn ra ở giai đoạn EXECUTE riêng biệt, không thuộc turn này.
- **EXECUTE ghi thẳng Connect DB** — không chạy Eloquent \`creating\`/\`created\`, không dispatch queue Job. Side-effect ghi DB mà app làm qua model event / Job **bắt buộc** có step insert riêng (không được ghi notes "async, không seed tay").
- Env nhãn: **${opts.environment}** (không bao giờ Production).
- **GitLab đọc:** nếu Scenario / follow-up có link issue hoặc \`#id\` / \`issue 123\`, hệ thống đã kéo sẵn vào mục "GitLab task (chỉ đọc)" bên dưới — dùng block đó để hiểu yêu cầu seed. **Không** tự gọi GitLab API / MCP / \`glab\`.

## Ưu tiên tool
1. \`code_map_query\` để định vị screen/feature/symbol liên quan đến yêu cầu.
2. \`code_map_path\` / \`code_map_explain\` để nối UI ↔ BE ↔ model.
3. Grep/Shell CHỈ dùng khi đã biết path cụ thể cần đọc và code_map không đủ chi tiết (vd đọc nội dung 1 file đã xác định).

${opts.graphifyBlock ? `${opts.graphifyBlock}\n` : ""}${opts.knowledgeBlock ? `${opts.knowledgeBlock}\n` : ""}${opts.gitlabTaskBlock ? `${opts.gitlabTaskBlock}\n\n` : ""}## Quy trình bắt buộc (UI → BE → data phát sinh)
1. Locator: rút yêu cầu thành screen/feature/symbol, tra bằng code_map_query trước.
2. Trace flow thật: form (Vue/React) → route/API handler → service/use-case → model/repo.
3. Validate: liệt kê rule bắt buộc/unique/format/FK/enum/default từ form + BE (DTO, validator, middleware).
4. Điền data (QUAN TRỌNG):
   - Giá trị người dùng **đã nêu** → dùng đúng giá trị đó.
   - Field bắt buộc / FK / unique / format mà người dùng **chưa nêu** → **TỰ SINH** giá trị hợp lệ (theo rule đã đọc: độ dài, regex, enum, unique giả lập, FK trỏ bản ghi seed trước hoặc mẫu hợp lệ từ DB đọc được). Ghi ngắn trong "notes" field nào đã auto-fill.
   - **FK catalog / master data** (country, structure, layer, job_level, position, …): nếu Connect DB ON → dùng **id thật** ghi **literal** vào data (ObjectId/string/number). Ưu tiên lấy từ block "DB context (pre-fetched)" nếu id cần thiết đã có sẵn ở đó; chỉ \`query_*\` khi cần bản ghi khác. KHÔNG được bịa step giả như \`fk_catalog\` / \`{{fk_catalog.country_id}}\`.
   - Placeholder \`{{step_id.field}}\` CHỈ được dùng khi \`step_id\` là một step **có thật** trong mảng \`steps\` (thường là insert trước đó → \`{{insert_staff_a._id}}\`).
   - Ví dụ: "tạo NV mới tên An" → name=An, còn lại (code, email, cccd, department_id…) AI tự lo cho đủ validate.
5. Giá trị người dùng **vi phạm** validate (format/độ dài/enum/unique rõ ràng) → **KHÔNG** tạo step chứa giá trị sai. Trả "steps": [] và đưa lỗi vào "questions". Ví dụ: "cccd=33333" nhưng rule yêu cầu 12 số → báo lỗi, không insert.
   Cách viết "questions" (QUAN TRỌNG):
   - "reason" viết **ngôn ngữ tự nhiên** cho người dùng cuối đọc — như thể chính hệ thống đang báo lỗi.
   - **Ưu tiên trích NGUYÊN VĂN câu thông báo validate của app**: tìm message thật trong source (resources/lang, validation messages, message trong FE rule/validator, chuỗi trong helper như MaxLeaveHelper) và dùng đúng câu đó (giữ nguyên ngôn ngữ gốc của app). Chỉ tự diễn đạt khi source không có message sẵn.
   - Sau câu báo lỗi: tối đa 1–2 câu gợi ý cách sửa (vd "Chọn khoảng ≤10 ngày làm việc, tránh ngày 15/09 đã có đơn").
   - KHÔNG nhét chi tiết kỹ thuật vào "reason": không _id, không tên file/hàm/collection, không "process_stage_id=…". Các chi tiết đó (nguồn rule, file, id bản ghi liên quan) đưa vào "notes".
6. Data phát sinh / side-effect (BẮT BUỘC — Create Data không fire model event / queue):
   - Mọi bảng/collection phụ mà BE luôn tạo kèm (profile, history, role map, …) → step insert riêng.
   - Model \`created\`/\`saved\` dispatch Job ghi DB (vd Staff::created → GenerateAnnualLeaveForStaffJob → collection staff_leaves; AssignPayrollFormulaForStaffJob → bảng công thức lương…) → **PHẢI** thêm step insert tương ứng sau step entity chính. Không bỏ với lý do "job async".
   - Cách làm: đọc Job/helper để biết collection + field; nếu Connect DB ON thì \`query_*\` mẫu bản ghi thật / rule (StaffLeaveAutoGenerateRule) rồi mirror field tối thiểu hợp lệ (type=annual_leave, year=năm hiện tại, staff_id={{insert_staff_x._id}}, quota/standard/status/start_time/end_time…).
   - Chỉ được bỏ side-effect nếu Job **chỉ** gửi email/notify và **không** insert/update DB.
7. Schema thật: tên bảng/collection + kiểu dữ liệu phải khớp model/migration đã đọc được — trích rõ trong "notes" phần nào lấy từ đâu.
8. Nguồn schema:
${schemaSourceBlock}
${notesLine}
## Khi không tìm thấy flow tương ứng trong code
- KHÔNG suy đoán entity/bảng bừa. Trả "steps": [] và giải thích trong "questions" (vd: feature/API tương ứng chưa tìm thấy trong code, cần path hoặc tên feature).
- Phân biệt: thiếu **tên entity/flow** → hỏi; thiếu **giá trị field** sau khi đã biết schema → tự sinh (không hỏi).
- Thiếu **FK catalog id** mà không query được DB → steps: [] + questions (cần Connect DB hoặc chỉ định id).

## Cấm
- Không insert theo suy đoán tên entity khi chưa đọc flow thật.
- Không bỏ validation bắt buộc — mọi field trong data phải thỏa rule đã đọc.
- Không bỏ bảng/collection phụ mà code luôn tạo kèm.
- Không bỏ side-effect Job/model-event ghi DB (vd phép năm staff_leaves) với lý do "async / không seed tay".
- Không đề xuất HTTP method/endpoint trong JSON.
- Không hỏi lại field bắt buộc chỉ vì user chưa nêu — hãy auto-fill trừ khi không suy ra được rule/schema hợp lệ.
- Không "sửa ngầm" giá trị user đưa sai cho khớp rule — phải báo lỗi trong questions.
- **Không** dùng placeholder trỏ step không tồn tại (\`{{fk_catalog.*}}\`, \`{{catalog.*}}\`, …). FK master phải là literal id từ query_* hoặc từ step insert trước đó.
- **Không** gọi GitLab API / MCP — chỉ dùng block "GitLab task (chỉ đọc)" nếu đã được nạp.
- **Thuật ngữ:** «nhân viên» / staff / NV / employee → collection **Staff** (thường \`staffs\`), **KHÔNG** dùng \`users\` trừ khi user nói rõ «người dùng / user account».
- **Số lượng:** chỉ tạo đúng số bản ghi user **đã nêu** cạnh từ nhân viên/staff/user (vd "tạo 2 nhân viên"). Không lấy số từ ngày/tháng/năm (2026, tháng 9…) làm số lượng insert. Không nêu số → mặc định **1** bản ghi chính (+ side-effect bắt buộc). Cấm sinh hàng chục step chỉ vì đoán.

## Output bắt buộc
Prose tiếng Việt, 3–6 câu: flow đã trace (UI → BE), validate chính, field nào auto-fill, field nào user cung cấp (hoặc lỗi validate nếu có).

Sau đó đúng 1 JSON block (\`\`\`json), theo schema:

\`\`\`json
{
  "steps": [
    {
      "step_id": "string, duy nhất, snake_case",
      "description": "string, mô tả ngắn mirror logic nào",
      "op": "insert | update | delete",
      "collection": "string, tên bảng/collection thật",
      "data": { } | null,
      "filter": { } | null,
      "depends_on": ["step_id", "..."],
      "rollback": true | false
    }
  ],
  "questions": [
    {
      "field": "string, tên field lỗi hoặc thông tin còn thiếu (entity/flow)",
      "reason": "string, ngôn ngữ tự nhiên cho người dùng — ưu tiên nguyên văn message validate của app (từ lang/validator trong source) + 1-2 câu gợi ý sửa; KHÔNG chứa _id/tên file/tên hàm"
    }
  ],
  "notes": ["string — flow đã trace, auto-filled fields, side-effects, nguồn schema (DB thật / suy ra từ source)"]
}
\`\`\`

### Quy tắc plan
- op = insert → data bắt buộc, filter = null. data phải đủ field bắt buộc (user + auto-fill).
- op = update → data + filter đều bắt buộc, filter không rỗng.
- op = delete → filter bắt buộc, không rỗng; data = null.
- depends_on liệt kê đúng step_id mà step hiện tại tham chiếu qua placeholder {{step_id.field}} / {{step_id.id}} / {{step_id._id}}.
- Mọi {{step_id.*}} phải khớp một step_id có trong mảng steps (step đó đứng trước). Không bịa step ảo.
- FK master/catalog: ưu tiên literal id từ query_*; chỉ dùng placeholder khi trỏ bản ghi do step trước vừa insert.
- Thứ tự steps trong mảng phải theo đúng dependency nghiệp vụ (step bị phụ thuộc đứng trước).
- User giá trị sai validate → steps: [] + questions (validation error).
- Không biết entity/flow trong code → steps: [] + questions (cần làm rõ feature).
- Đã biết flow + schema → ưu tiên steps đầy đủ với auto-fill; questions chỉ khi thật sự không suy ra được.

## Yêu cầu người dùng
${opts.prompt}
${opts.gitlabTaskBlock ? `\n(Nếu có block GitLab task ở trên: coi mô tả / comment issue là một phần của yêu cầu seed — trích giá trị nghiệp vụ từ đó, không chỉ dựa vào câu Scenario ngắn.)\n` : ""}${opts.refineBlock || ""}`;
}

/** Collection names that usually hold master/catalog data (FK targets). */
const CATALOG_NAME_RE =
  /(structure|countr|position|level|layer|location|department|master|catalog|role|setting|currency|branch|title|grade|unit|type|config|holiday|shift|rule)/i;

const SCHEMA_HINT_MAX_CHARS = 12_000;

/**
 * MongoDB: list collections + one sample doc from scoped / catalog collections.
 * When `targetCollections` is set (Pass 1 scope), prefer those (+ catalog FKs).
 */
async function fetchMongoSchemaHint(
  cfg: BaDbConnectionResolved,
  userPrompt: string,
  targetCollections?: string[],
): Promise<string | null> {
  const list = await runBaReadonlyQuery(cfg, '{"op":"listCollections"}');
  const names = list.rows
    .map((r) => String(r.name || ""))
    .filter(Boolean)
    .sort();
  if (!names.length) return null;

  const nameSet = new Set(names.map((n) => n.toLowerCase()));
  const resolveName = (want: string) => {
    const w = want.toLowerCase();
    if (nameSet.has(w)) return names.find((n) => n.toLowerCase() === w)!;
    const plural = w.endsWith("s") ? w : `${w}s`;
    if (nameSet.has(plural)) {
      return names.find((n) => n.toLowerCase() === plural)!;
    }
    return names.find(
      (n) =>
        n.toLowerCase().includes(w) || w.includes(n.toLowerCase().replace(/s$/, "")),
    );
  };

  const promptTokens = new Set(
    userPrompt.toLowerCase().match(/[a-z_]{4,}/g) || [],
  );
  const forced = new Set<string>();
  for (const t of targetCollections || []) {
    const hit = resolveName(t);
    if (hit) forced.add(hit);
  }

  const scored = names.map((name) => {
    const lower = name.toLowerCase();
    let score = 0;
    if (forced.has(name)) score += 10;
    if (CATALOG_NAME_RE.test(lower)) score += 2;
    for (const t of promptTokens) {
      if (lower.includes(t) || t.includes(lower.replace(/s$/, ""))) {
        score += 1;
        break;
      }
    }
    return { name, score };
  });

  const maxSamples = CREATE_DATA_KNOWLEDGE_DEFAULTS.targetedSampleMax;
  const picked = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSamples);

  const settled = await Promise.allSettled(
    picked.map(async ({ name }) => {
      const res = await runBaReadonlyQuery(
        cfg,
        JSON.stringify({ op: "find", collection: name, limit: 1 }),
      );
      const doc = res.rows[0];
      if (!doc) return null;
      return `### ${name}\n${JSON.stringify(doc).slice(0, 700)}`;
    }),
  );
  const sampleBlocks = settled
    .map((s) => (s.status === "fulfilled" ? s.value : null))
    .filter((v): v is string => Boolean(v));

  const parts = [`Collections (${names.length}): ${names.join(", ")}`];
  if (targetCollections?.length) {
    parts.push(
      `Pass 1 scope (sample ưu tiên): ${[...forced].join(", ") || targetCollections.join(", ")}`,
    );
  }
  if (sampleBlocks.length) {
    parts.push(
      "Sample docs (1/collection — id/field là dữ liệu THẬT; dùng trực tiếp làm literal FK id, chỉ query_* thêm khi cần bản ghi khác hoặc xác nhận rule):\n" +
        sampleBlocks.join("\n"),
    );
  }
  return parts.join("\n\n").slice(0, SCHEMA_HINT_MAX_CHARS);
}

/**
 * Pre-fetch schema context on the API side so the agent starts with real DB
 * knowledge instead of spending its first tool round-trips on discovery.
 * Best-effort — planner works without it.
 */
async function fetchDbSchemaHint(
  cfg: BaDbConnectionResolved,
  userPrompt: string,
  targetCollections?: string[],
): Promise<string | null> {
  try {
    if (cfg.dialect === "mongodb") {
      return await fetchMongoSchemaHint(cfg, userPrompt, targetCollections);
    }
    const query =
      cfg.dialect === "postgres"
        ? "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
        : "SHOW TABLES";
    const res = await runBaReadonlyQuery(cfg, query);
    const text = formatQueryResultForAgent(res);
    return text ? text.slice(0, SCHEMA_HINT_MAX_CHARS) : null;
  } catch (err) {
    logger.warn("Create Data schema hint prefetch failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Cursor SDK Seed Planner — same stack as BA chat (code_map + optional DB tools).
 * Agent must trace UI→BE create flow (validate + side-effect writes), then emit DB steps.
 * Falls back to heuristic planner if agent/key/repo unavailable.
 */
export async function runCreateDataPlannerAgent(opts: {
  userId: string;
  baProjectId: string;
  prompt: string;
  environment: CreateDataEnvironment;
  /** Refine turn: follow-up message + previous plan (stateless multi-turn). */
  followUp?: string | null;
  previousPlan?: {
    steps: unknown[];
    questions: string[];
    notes: string[];
  } | null;
}): Promise<
  CreateDataPlanResponse & {
    planner: "ai" | "heuristic";
    metrics?: CreateDataPlanMetrics;
  }
> {
  const project = await getBaProject(opts.baProjectId);
  if (!project) {
    const plan = buildSeedPlan(opts.prompt);
    return { ...plan, planner: "heuristic" };
  }

  const seedCfg = toPublicBaCreateData(project.createData);

  const repoReady =
    project.cloneStatus === "ready" && (await isGitRepo(project.localPath));

  if (!repoReady) {
    const plan = buildSeedPlan(opts.prompt);
    plan.notes = [
      ...(plan.notes || []),
      "AI planner skipped — project source not ready; heuristic plan only. Ask admin to clone.",
    ];
    return { ...plan, planner: "heuristic" };
  }

  let apiKey: string;
  try {
    apiKey = await resolveSystemCursorApiKey();
  } catch {
    const plan = buildSeedPlan(opts.prompt);
    plan.notes = [
      ...(plan.notes || []),
      "AI planner skipped — no Cursor API key; heuristic plan only.",
    ];
    return { ...plan, planner: "heuristic" };
  }

  const key = cancelKey(opts.userId, opts.baProjectId);
  clearJobKillRequested(key);
  if (isJobKillRequested(key)) {
    throw new Error("Force-stopped from UI");
  }
  const session = beginCancellableJob(key);

  try {
    publishProgress({
      userId: opts.userId,
      baProjectId: opts.baProjectId,
      step: "pull",
      label: "Syncing source…",
      detail: project.mainBranch || "main",
    });
    session.check();
    try {
      await pullBaProjectLatest(project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Create Data planner git pull failed", {
        projectId: project.id,
        err: redactGitCredentials(msg),
      });
      // Continue with existing checkout
    }

    const model = await resolveSystemCursorModelSpec();
    const modelLabel = cursorModelLogLabel(await resolveSystemCursorModel());

    const seedDbCfg = isBaCreateDataDbAccessAllowed(project)
      ? await resolveBaCreateDataDb(project.id)
      : null;
    const projectDbCfg =
      !seedDbCfg && isBaDbAccessAllowed(project)
        ? await resolveBaProjectDb(project.id)
        : null;
    const dbCfg = seedDbCfg || projectDbCfg;
    const dbAccess = {
      allowed: Boolean(dbCfg),
      dialect: dbCfg?.dialect,
      database: dbCfg?.database,
      host: dbCfg?.host,
    };

    publishProgress({
      userId: opts.userId,
      baProjectId: opts.baProjectId,
      step: "read",
      label: "Code map (graphify)…",
    });
    session.check();
    const pass1Started = Date.now();
    const headSha = await readProjectHeadSha(project.localPath);
    const knowledge = await getCreateDataKnowledge(project.id);
    const scope = detectCreateDataScope({
      texts: [opts.prompt, opts.followUp || ""],
      knowledge,
    });
    const pass1Ms = Date.now() - pass1Started;

    // Pass 1 early exit only when knowledge is ready but scope still ambiguous.
    if (
      knowledge?.status === "ready" &&
      scope.ambiguous &&
      !opts.followUp
    ) {
      const early = {
        steps: [],
        questions: [scope.reason],
        notes: [
          "Pass 1 (scope detection) could not map the scenario to collections — refine the scenario or refresh seed knowledge.",
        ],
        planner: "ai" as const,
        metrics: {
          pass1Ms,
          pass2Ms: 0,
          toolCalls: 0,
          codeMapCache: "skip" as const,
          knowledgeStatus: knowledge.status,
          scopedCollections: [],
        },
      };
      publishProgress({
        userId: opts.userId,
        baProjectId: opts.baProjectId,
        step: "done",
        label: "Needs clarification · scope",
        plan: early,
      });
      return early;
    }

    const graphReadyBefore = await ensureProjectGraphifyReady(
      project.localPath,
    );
    session.check();
    const graphifyQuery = await queryProjectGraphify(
      project.localPath,
      [
        opts.prompt,
        scope.collections.length
          ? `collections: ${scope.collections.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" | "),
    );
    const graphifyBlock = formatBaGraphifyPromptBlock({
      sourcePath: project.localPath,
      queryText: graphifyQuery,
    });
    const codeMapCache: CreateDataPlanMetrics["codeMapCache"] = graphReadyBefore
      ? "hit"
      : "miss";

    const knowledgeBlock = formatKnowledgePromptBlock({
      knowledge,
      scope,
      headSha,
      pass2ToolBudget: CREATE_DATA_KNOWLEDGE_DEFAULTS.pass2ToolBudget,
    });

    // Same as BA chat: Scenario / follow-up may include GitLab link or #id.
    const gitlabTexts = [opts.prompt, opts.followUp || ""].filter((t) =>
      t.trim(),
    );
    let gitlabTaskBlock = "";
    if (gitlabTexts.length && project.gitlabHost && project.gitlabPath) {
      publishProgress({
        userId: opts.userId,
        baProjectId: opts.baProjectId,
        step: "read",
        label: "Reading GitLab issue…",
      });
      session.check();
      const gitlabToken = await getBaProjectGitlabToken(project.id);
      const gitlab = await loadBaGitlabTaskBlock({
        gitlabHost: project.gitlabHost,
        gitlabPath: project.gitlabPath,
        token: gitlabToken,
        texts: gitlabTexts,
      });
      gitlabTaskBlock = gitlab.block;
      if (gitlab.refs.length) {
        publishProgress({
          userId: opts.userId,
          baProjectId: opts.baProjectId,
          step: "read",
          label: `GitLab #${gitlab.refs.map((r) => r.iid).join(", #")}`,
        });
      }
    }

    const refineBlock =
      opts.followUp && opts.previousPlan
        ? buildRefineBlock({
            followUp: opts.followUp,
            previousPlan: opts.previousPlan,
          })
        : "";
    const prompt = buildSeedPlannerPrompt({
      displayName: project.displayName,
      mainBranch: project.mainBranch || "main",
      prompt: opts.prompt,
      environment: opts.environment,
      seedNotes: seedCfg.notes,
      dbAccess,
      graphifyBlock,
      knowledgeBlock,
      gitlabTaskBlock,
      refineBlock,
    });

    publishProgress({
      userId: opts.userId,
      baProjectId: opts.baProjectId,
      step: "start",
      label: "Seed Planner (Cursor)…",
      detail: dbAccess.allowed
        ? `${modelLabel} · DB ON${dbCfg?.ssh?.enabled ? " · SSH" : ""}`
        : modelLabel,
    });

    let toolCalls = 0;
    const toolBudget = CREATE_DATA_KNOWLEDGE_DEFAULTS.pass2ToolBudget;
    const pass2Started = Date.now();

    const work = async (): Promise<string> => {
      session.check();
      const runAgent = async (
        toolsCfg: typeof dbCfg,
      ): Promise<string> => {
        // Targeted prefetch: listCollections + samples for Pass 1 scope.
        let schemaHint: string | null = null;
        if (toolsCfg) {
          publishProgress({
            userId: opts.userId,
            baProjectId: opts.baProjectId,
            step: "tool",
            label: "Prefetching DB collections…",
          });
          schemaHint = await fetchDbSchemaHint(
            toolsCfg,
            opts.prompt,
            scope.collections,
          );
        }
        const agentPrompt = schemaHint
          ? `${prompt}\n\n## DB context (pre-fetched, read-only — dùng ngay, không cần listCollections/SHOW TABLES lại)\n${schemaHint}`
          : prompt;

        const dbTools = toolsCfg
          ? (buildBaDbCustomTools(toolsCfg) as never)
          : null;
        const proposeTools = buildProposeSeedKnowledgeTool(project.id);
        const customTools = {
          ...mergeBaAgentCustomTools(project.localPath, dbTools),
          ...proposeTools,
        };
        const agent = await Agent.create({
          apiKey,
          model,
          ...readOnlyAgentPolicy(),
          mcpServers: {},
          local: {
            cwd: project.localPath,
            settingSources: [],
            ...(Object.keys(customTools).length
              ? { customTools: customTools as never }
              : {}),
          },
        });

        await using disposed = agent;
        session.check();
        const run = await disposed.send(agentPrompt);
        session.attach(run);

        let streamed = "";
        try {
          if (
            typeof run.stream === "function" &&
            run.supports?.("stream") !== false
          ) {
            for await (const message of run.stream()) {
              session.check();
              const { text, toolLabel } = extractAssistantText(
                message as {
                  type?: string;
                  message?: {
                    content?: Array<{ type?: string; text?: string }>;
                  };
                  name?: string;
                  args?: unknown;
                  status?: string;
                },
              );
              if (toolLabel) {
                toolCalls += 1;
                publishProgress({
                  userId: opts.userId,
                  baProjectId: opts.baProjectId,
                  step: "tool",
                  label: toolLabel,
                });
                if (toolCalls > toolBudget) {
                  throw new Error(
                    `Tool-call budget exceeded (${toolBudget}) — stopping Pass 2; refine the scenario or refresh seed knowledge`,
                  );
                }
              }
              if (!text) continue;
              if (text.startsWith(streamed) && text.length >= streamed.length) {
                streamed = text;
              } else if (!(streamed && streamed.endsWith(text))) {
                streamed += text;
              }
              if (streamed.length > 40) {
                publishProgress({
                  userId: opts.userId,
                  baProjectId: opts.baProjectId,
                  step: "write",
                  label: "Drafting plan…",
                });
              }
            }
          }
        } catch (err) {
          if (!isTransientCursorTransportError(err)) {
            logger.warn("Create Data planner stream error", {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }

        session.check();
        const result = await run.wait();
        if (result.status === "cancelled") {
          throw new Error("Force-stopped from UI");
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
            { label: "Create Data" },
          );
        }

        const fromResult = String(
          (result as { result?: string }).result || "",
        ).trim();
        const finalText = fromResult || streamed.trim();
        if (!finalText) throw new Error("Agent returned an empty plan");

        await persistCursorUsage({
          kind: "ba_create_data",
          userId: opts.userId,
          agent: disposed,
          run,
          result,
          promptChars: agentPrompt.length,
          outputChars: finalText.length,
          model: await resolveSystemCursorModel(),
        });

        return finalText;
      };

      // Keep SSH tunnel open for the whole planner turn so query_* tools reuse it.
      if (dbCfg?.ssh?.enabled) {
        return withBaDbResolvedConnection(dbCfg, (connectCfg) =>
          runAgent(connectCfg),
        );
      }
      return runAgent(dbCfg);
    };

    const maxRetries = Math.max(0, getConfig().AGENT_TRANSIENT_RETRIES);
    let attempt = 0;
    while (true) {
      try {
        const answer = await withTimeout(work(), PLAN_TIMEOUT_MS, "Create Data");
        const pass2Ms = Date.now() - pass2Started;
        const metrics: CreateDataPlanMetrics = {
          pass1Ms,
          pass2Ms,
          toolCalls,
          codeMapCache,
          knowledgeStatus: knowledge?.status ?? "absent",
          scopedCollections: scope.collections,
        };
        logger.info("Create Data planner metrics", {
          baProjectId: opts.baProjectId,
          ...metrics,
        });
        const parsed = parseSeedPlanFromAgent(answer);
        if (parsed) {
          if (dbAccess.allowed) {
            parsed.notes = [
              ...(parsed.notes || []),
              `Connect DB target (${opts.environment}): ${dbAccess.dialect} / ${dbAccess.database}`,
            ];
          }
          const afterSideEffects = applySideEffectValidation(
            parsed,
            knowledge?.sideEffectEdges || [],
          );
          const { sideEffectGaps, ...alignedBase } = afterSideEffects;
          const planBody = assertPlanEntityAlignment(
            opts.prompt,
            alignedBase,
            scope.collections,
          );
          planBody.notes = [
            ...(planBody.notes || []),
            `metrics: pass1=${pass1Ms}ms pass2=${pass2Ms}ms tools=${toolCalls} codeMap=${codeMapCache}`,
          ];
          const ready = { ...planBody, planner: "ai" as const, metrics };
          publishProgress({
            userId: opts.userId,
            baProjectId: opts.baProjectId,
            step: "done",
            label: sideEffectGaps.length
              ? `Needs side-effects · ${sideEffectGaps.length} gap(s)`
              : planBody.steps.length
                ? `Plan ready · ${planBody.steps.length} steps`
                : "Needs clarification",
            plan: ready,
          });
          return ready;
        }
        logger.warn("Create Data agent plan parse failed; heuristic fallback", {
          projectId: opts.baProjectId,
        });
        const fallback = buildSeedPlan(opts.prompt);
        fallback.notes = [
          ...(fallback.notes || []),
          "AI replied but plan JSON was incomplete — heuristic fallback.",
          `metrics: pass1=${pass1Ms}ms pass2=${pass2Ms}ms tools=${toolCalls} codeMap=${codeMapCache}`,
        ];
        const heuristic = {
          ...fallback,
          planner: "heuristic" as const,
          metrics,
        };
        publishProgress({
          userId: opts.userId,
          baProjectId: opts.baProjectId,
          step: "done",
          label: "Heuristic fallback",
          plan: heuristic,
        });
        return heuristic;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (/Force-stopped|cancelled/i.test(raw)) throw err;
        if (/Tool-call budget exceeded/i.test(raw)) {
          const metrics: CreateDataPlanMetrics = {
            pass1Ms,
            pass2Ms: Date.now() - pass2Started,
            toolCalls,
            codeMapCache,
            knowledgeStatus: knowledge?.status ?? "absent",
            scopedCollections: scope.collections,
          };
          const budgetPlan = {
            steps: [],
            questions: [
              "Planner stopped: tool-call budget reached before the plan was complete. Narrow the scenario, refresh seed knowledge, or Refine with more detail.",
            ],
            notes: [
              raw.slice(0, 200),
              `metrics: pass1=${pass1Ms}ms tools=${toolCalls} budget=${toolBudget}`,
            ],
            planner: "ai" as const,
            metrics,
          };
          publishProgress({
            userId: opts.userId,
            baProjectId: opts.baProjectId,
            step: "done",
            label: "Budget exceeded · need clarification",
            plan: budgetPlan,
          });
          return budgetPlan;
        }
        if (
          isTransientCursorTransportError(err) &&
          attempt < maxRetries
        ) {
          attempt++;
          logger.warn("Create Data planner transient retry", {
            attempt,
            err: raw,
          });
          continue;
        }
        logger.warn("Create Data AI planner failed; heuristic fallback", {
          err: raw,
        });
        const fallback = buildSeedPlan(opts.prompt);
        fallback.notes = [
          ...(fallback.notes || []),
          `AI planner error: ${raw.slice(0, 200)} — heuristic fallback.`,
        ];
        const heuristic = { ...fallback, planner: "heuristic" as const };
        publishProgress({
          userId: opts.userId,
          baProjectId: opts.baProjectId,
          step: "error",
          label: "AI failed · heuristic plan",
          detail: raw.slice(0, 120),
          plan: heuristic,
        });
        return heuristic;
      }
    }
  } finally {
    session.end();
  }
}

export async function stopCreateDataPlanner(
  userId: string,
  baProjectId: string,
): Promise<boolean> {
  return cancelActiveAgentRun(cancelKey(userId, baProjectId));
}
