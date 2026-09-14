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
  const dbLine = opts.dbAccess.allowed
    ? `- Connect DB ON (**${opts.dbAccess.dialect}** @ \`${opts.dbAccess.host}\` / \`${opts.dbAccess.database}\`) — dùng tool query_* để đọc schema / FK / mẫu. Execute sẽ **ghi thẳng** DB này (insert/update/delete).`
    : `- Connect DB chưa bật — suy ra schema từ source (model/migration). User phải bật Connect DB trước khi execute.`;

  const notesLine = opts.seedNotes
    ? `- Ghi chú seed (admin): ${opts.seedNotes}`
    : "";

  return `Bạn là **Seed Data Planner** cho project **${opts.displayName}** (branch ${opts.mainBranch}).

## Vai trò (read-only workspace khi plan)
- Chỉ đọc source + DB read-only tools để lập plan — **không** sửa file / commit / push trong workspace.
- Ưu tiên tool \`code_map_*\` trước Grep/Shell. Shell chỉ khi thật sự cần đọc file đã biết path.
- Deliverable = JSON plan trong chat — không ghi disk. (Execute riêng sẽ ghi Connect DB.)

## Nhiệm vụ
Lập kế hoạch tạo dữ liệu test **ghi thẳng Connect DB** (insert / update / delete) — **KHÔNG** dùng HTTP API.

Env nhãn: **${opts.environment}** (không bao giờ Production).

${opts.graphifyBlock ? `${opts.graphifyBlock}\n` : ""}
## Nguồn sự thật
1. Gọi \`code_map_query\` với locator ngắn (entity / model / collection) **trước** Grep.
2. Đọc model/migration/schema trong source để lấy tên bảng/collection + field bắt buộc.
3. ${dbLine}
${notesLine}

## Yêu cầu người dùng
${opts.prompt}

## Output (BẮT BUỘC)
Cuối câu trả lời xuất **đúng 1** JSON block (fence \`\`\`json):

\`\`\`json
{
  "steps": [
    {
      "step_id": "create_user_1",
      "description": "Insert user #1",
      "op": "insert",
      "collection": "users",
      "data": { "email": "…" },
      "filter": null,
      "depends_on": [],
      "rollback": true
    }
  ],
  "questions": [],
  "notes": ["…"]
}
\`\`\`

### Quy tắc plan
- \`op\`: chỉ \`insert\` | \`update\` | \`delete\`.
- \`collection\`: tên bảng (SQL) hoặc collection (Mongo) — khớp schema thật, không bịa.
- \`insert\`: bắt buộc \`data\`; \`update\`: \`data\` + \`filter\`; \`delete\`: \`filter\` (filter không được rỗng).
- Thứ tự đúng dependency; dùng placeholder \`{{step_id.field}}\` / \`{{step_id.id}}\` / \`{{step_id._id}}\` để nối kết quả bước trước.
- Thiếu thông tin bắt buộc → điền \`questions\`, có thể \`steps: []\`.
- Không bao giờ nhắm Production; không đề xuất HTTP method/endpoint.
- Trong message prose: tóm tắt ngắn (tiếng Việt) + JSON ở cuối.`;
}

/**
 * Cursor SDK Seed Planner — same stack as BA chat (code_map + optional DB tools).
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
