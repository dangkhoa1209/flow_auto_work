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
  isBaDbAccessAllowed,
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
import { mergeBaAgentCustomTools } from "../../plugins/ba/graphifyTools.js";
import { buildSeedPlan } from "./planner.js";
import { parseSeedPlanFromAgent } from "./parsePlan.js";
import type {
  CreateDataEnvironment,
  CreateDataPlanResponse,
} from "./types.js";

const PLAN_TIMEOUT_MS = 8 * 60 * 1000;

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
}) {
  publishRealtime({
    type: "create_data_progress",
    userId: opts.userId,
    baProjectId: opts.baProjectId,
    step: opts.step,
    label: opts.label,
    detail: opts.detail,
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
    ? `- Connect DB ON (**${opts.dbAccess.dialect}** @ \`${opts.dbAccess.host}\` / \`${opts.dbAccess.database}\`): dùng query_* (đọc) để xác nhận schema/FK/mẫu dữ liệu thật trước khi viết step.`
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
- Env nhãn: **${opts.environment}** (không bao giờ Production).

## Ưu tiên tool
1. \`code_map_query\` để định vị screen/feature/symbol liên quan đến yêu cầu.
2. \`code_map_path\` / \`code_map_explain\` để nối UI ↔ BE ↔ model.
3. Grep/Shell CHỈ dùng khi đã biết path cụ thể cần đọc và code_map không đủ chi tiết (vd đọc nội dung 1 file đã xác định).

${opts.graphifyBlock ? `${opts.graphifyBlock}\n` : ""}## Quy trình bắt buộc (UI → BE → data phát sinh)
1. Locator: rút yêu cầu thành screen/feature/symbol, tra bằng code_map_query trước.
2. Trace flow thật: form (Vue/React) → route/API handler → service/use-case → model/repo.
3. Validate: liệt kê rule bắt buộc/unique/format/FK/enum/default từ form + BE (DTO, validator, middleware). Field bắt buộc mà người dùng chưa cho → đưa vào "questions", không tự bịa giá trị.
4. Data phát sinh: mọi bảng/collection phụ mà BE luôn tạo kèm (profile, role map, wallet, log, counter, soft-delete flag...) phải có step riêng (hoặc field embed nếu Mongo).
5. Schema thật: tên bảng/collection + kiểu dữ liệu phải khớp model/migration đã đọc được — trích rõ trong "notes" phần nào lấy từ đâu.
6. Nguồn schema:
${schemaSourceBlock}
${notesLine}
## Khi không tìm thấy flow tương ứng trong code
- KHÔNG suy đoán bừa. Trả "steps": [] và giải thích trong "questions" (vd: feature/API tương ứng chưa tìm thấy trong code, cần người dùng cung cấp path hoặc xác nhận feature name).

## Cấm
- Không insert theo suy đoán tên entity khi chưa đọc flow thật.
- Không bỏ validation bắt buộc.
- Không bỏ bảng/collection phụ mà code luôn tạo kèm.
- Không đề xuất HTTP method/endpoint trong JSON.

## Output bắt buộc
Prose tiếng Việt, 3–6 câu: flow đã trace (UI → BE), validate chính đã áp dụng, data phát sinh đã mirror.

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
      "field": "string, tên field/thông tin còn thiếu",
      "reason": "string, vì sao bắt buộc (trích rule đã đọc được)"
    }
  ],
  "notes": ["string — flow đã trace, side-effects, nguồn schema (DB thật / suy ra từ source)"]
}
\`\`\`

### Quy tắc plan
- op = insert → data bắt buộc, filter = null.
- op = update → data + filter đều bắt buộc, filter không rỗng.
- op = delete → filter bắt buộc, không rỗng; data = null.
- depends_on liệt kê đúng step_id mà step hiện tại tham chiếu qua placeholder {{step_id.field}} / {{step_id.id}} / {{step_id._id}}.
- Thứ tự steps trong mảng phải theo đúng dependency nghiệp vụ (step bị phụ thuộc đứng trước).
- Thiếu thông tin bắt buộc → để steps: [] hoặc chỉ các step không phụ thuộc thông tin thiếu, và luôn điền questions tương ứng.

## Yêu cầu người dùng
${opts.prompt}`;
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
      label: "Đồng bộ source…",
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

    const dbAllowed = isBaDbAccessAllowed(project);
    const dbCfg = dbAllowed
      ? await resolveBaProjectDb(project.id)
      : null;
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
      detail: dbAccess.allowed ? `${modelLabel} · DB ON` : modelLabel,
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
                label: "Đang soạn plan…",
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
        promptChars: prompt.length,
        outputChars: finalText.length,
        model: await resolveSystemCursorModel(),
      });

      return finalText;
    };

    const maxRetries = Math.max(0, getConfig().AGENT_TRANSIENT_RETRIES);
    let attempt = 0;
    while (true) {
      try {
        const answer = await withTimeout(work(), PLAN_TIMEOUT_MS, "Create Data");
        const parsed = parseSeedPlanFromAgent(answer);
        if (parsed) {
          publishProgress({
            userId: opts.userId,
            baProjectId: opts.baProjectId,
            step: "done",
            label: `Plan sẵn sàng · ${parsed.steps.length} steps`,
          });
          if (dbAccess.allowed) {
            parsed.notes = [
              ...(parsed.notes || []),
              `Connect DB target (${opts.environment}): ${dbAccess.dialect} ${dbAccess.host}/${dbAccess.database}`,
            ];
          }
          return { ...parsed, planner: "ai" };
        }
        logger.warn("Create Data agent plan parse failed; heuristic fallback", {
          projectId: opts.baProjectId,
        });
        const fallback = buildSeedPlan(opts.prompt);
        fallback.notes = [
          ...(fallback.notes || []),
          "AI replied but plan JSON was incomplete — heuristic fallback.",
        ];
        publishProgress({
          userId: opts.userId,
          baProjectId: opts.baProjectId,
          step: "done",
          label: "Heuristic fallback",
        });
        return { ...fallback, planner: "heuristic" };
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
        publishProgress({
          userId: opts.userId,
          baProjectId: opts.baProjectId,
          step: "error",
          label: "AI failed · heuristic plan",
          detail: raw.slice(0, 120),
        });
        return { ...fallback, planner: "heuristic" };
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
