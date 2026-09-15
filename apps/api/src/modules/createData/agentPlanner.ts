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
import { buildBaDbCustomTools } from "../../plugins/baDb/tools.js";
import {
  formatQueryResultForAgent,
  runBaReadonlyQuery,
} from "../../plugins/baDb/query.js";
import { withBaDbResolvedConnection } from "../../plugins/baDb/withTunnel.js";
import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import { mergeBaAgentCustomTools } from "../../plugins/ba/graphifyTools.js";
import { buildSeedPlan } from "./planner.js";
import { parseSeedPlanFromAgent } from "./parsePlan.js";
import type {
  CreateDataEnvironment,
  CreateDataPlanResponse,
} from "./types.js";

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

## Ưu tiên tool
1. \`code_map_query\` để định vị screen/feature/symbol liên quan đến yêu cầu.
2. \`code_map_path\` / \`code_map_explain\` để nối UI ↔ BE ↔ model.
3. Grep/Shell CHỈ dùng khi đã biết path cụ thể cần đọc và code_map không đủ chi tiết (vd đọc nội dung 1 file đã xác định).

${opts.graphifyBlock ? `${opts.graphifyBlock}\n` : ""}## Quy trình bắt buộc (UI → BE → data phát sinh)
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
${opts.prompt}`;
}

/** Collection names that usually hold master/catalog data (FK targets). */
const CATALOG_NAME_RE =
  /(structure|countr|position|level|layer|location|department|master|catalog|role|setting|currency|branch|title|grade|unit|type|config|holiday|shift|rule)/i;

const SCHEMA_HINT_MAX_CHARS = 12_000;
const SCHEMA_HINT_MAX_SAMPLES = 10;

/**
 * MongoDB: list collections + one sample doc from likely catalog/master-data
 * collections (scored by name pattern + user-prompt keywords). Sample docs give
 * the agent real ObjectIds to use as literal FK values without extra query_*
 * round-trips.
 */
async function fetchMongoSchemaHint(
  cfg: BaDbConnectionResolved,
  userPrompt: string,
): Promise<string | null> {
  const list = await runBaReadonlyQuery(cfg, '{"op":"listCollections"}');
  const names = list.rows
    .map((r) => String(r.name || ""))
    .filter(Boolean)
    .sort();
  if (!names.length) return null;

  const promptTokens = new Set(
    userPrompt.toLowerCase().match(/[a-z_]{4,}/g) || [],
  );
  const picked = names
    .map((name) => {
      const lower = name.toLowerCase();
      let score = 0;
      if (CATALOG_NAME_RE.test(lower)) score += 2;
      for (const t of promptTokens) {
        if (lower.includes(t) || t.includes(lower.replace(/s$/, ""))) {
          score += 1;
          break;
        }
      }
      return { name, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SCHEMA_HINT_MAX_SAMPLES);

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
): Promise<string | null> {
  try {
    if (cfg.dialect === "mongodb") {
      return await fetchMongoSchemaHint(cfg, userPrompt);
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
}): Promise<CreateDataPlanResponse & { planner: "ai" | "heuristic" }> {
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
    await ensureProjectGraphifyReady(project.localPath);
    session.check();
    const graphifyQuery = await queryProjectGraphify(
      project.localPath,
      opts.prompt,
    );
    const graphifyBlock = formatBaGraphifyPromptBlock({
      sourcePath: project.localPath,
      queryText: graphifyQuery,
    });

    const prompt = buildSeedPlannerPrompt({
      displayName: project.displayName,
      mainBranch: project.mainBranch || "main",
      prompt: opts.prompt,
      environment: opts.environment,
      seedNotes: seedCfg.notes,
      dbAccess,
      graphifyBlock,
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

    const work = async (): Promise<string> => {
      session.check();
      const runAgent = async (
        toolsCfg: typeof dbCfg,
      ): Promise<string> => {
        // Prefetch collection list so the agent skips its first discovery round-trip.
        let schemaHint: string | null = null;
        if (toolsCfg) {
          publishProgress({
            userId: opts.userId,
            baProjectId: opts.baProjectId,
            step: "tool",
            label: "Prefetching DB collections…",
          });
          schemaHint = await fetchDbSchemaHint(toolsCfg, opts.prompt);
        }
        const agentPrompt = schemaHint
          ? `${prompt}\n\n## DB context (pre-fetched, read-only — dùng ngay, không cần listCollections/SHOW TABLES lại)\n${schemaHint}`
          : prompt;

        const customTools = mergeBaAgentCustomTools(
          project.localPath,
          toolsCfg ? (buildBaDbCustomTools(toolsCfg) as never) : null,
        );
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
                publishProgress({
                  userId: opts.userId,
                  baProjectId: opts.baProjectId,
                  step: "tool",
                  label: toolLabel,
                });
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
        const parsed = parseSeedPlanFromAgent(answer);
        if (parsed) {
          if (dbAccess.allowed) {
            parsed.notes = [
              ...(parsed.notes || []),
              `Connect DB target (${opts.environment}): ${dbAccess.dialect} ${dbAccess.host}/${dbAccess.database}`,
            ];
          }
          const ready = { ...parsed, planner: "ai" as const };
          publishProgress({
            userId: opts.userId,
            baProjectId: opts.baProjectId,
            step: "done",
            label: `Plan ready · ${parsed.steps.length} steps`,
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
        ];
        const heuristic = { ...fallback, planner: "heuristic" as const };
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
