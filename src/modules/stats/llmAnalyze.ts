import { Agent, CursorAgentError } from "@cursor/sdk";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import {
  errorFromCursorRunStatus,
  formatCursorAgentFailure,
} from "../../plugins/agent/run.js";
import type { DevRecommendation, TaskTypeStats } from "./analyze.js";
import type { AnalysisJob, SkillDimensions } from "./scoring.js";

export const DEV_ANALYSIS_ENGINE = "cursor-sdk-v2";

const DIMS = [
  "speed",
  "accuracy",
  "scope",
  "consistency",
  "efficiency",
] as const;

const MAX_JOBS_IN_PROMPT = 80;

export type LlmAnalysisPayload = {
  narrative: string;
  recommendations: DevRecommendation[];
  dimensions?: SkillDimensions;
};

type RawRec = {
  id?: unknown;
  dimension?: unknown;
  severity?: unknown;
  text?: unknown;
  evidenceJobIds?: unknown;
};

function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function clampScore(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

function parseDimensions(raw: unknown): SkillDimensions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const speed = clampScore(o.speed);
  const accuracy = clampScore(o.accuracy);
  const scope = clampScore(o.scope);
  const consistency = clampScore(o.consistency);
  const efficiency = clampScore(o.efficiency);
  if (
    speed == null ||
    accuracy == null ||
    scope == null ||
    consistency == null ||
    efficiency == null
  ) {
    return undefined;
  }
  return { speed, accuracy, scope, consistency, efficiency };
}

function isDim(v: unknown): v is DevRecommendation["dimension"] {
  return typeof v === "string" && (DIMS as readonly string[]).includes(v);
}

function compactJobs(jobs: AnalysisJob[]) {
  const failed = jobs.filter((j) => j.status === "failed");
  const rest = jobs.filter((j) => j.status !== "failed");
  const picked = [...failed, ...rest].slice(0, MAX_JOBS_IN_PROMPT);
  return picked.map((j) => ({
    jobId: j.jobId,
    iid: j.issueIid,
    title: j.title.slice(0, 120),
    status: j.status,
    type: j.taskType,
    workMin:
      j.workDurationMs != null && j.workDurationMs > 0
        ? Math.round(j.workDurationMs / 60_000)
        : null,
    wallMin:
      j.durationMs != null && j.durationMs > 0
        ? Math.round(j.durationMs / 60_000)
        : null,
    tokens: j.tokensTotal || 0,
    runs: j.runCount || 0,
    failReason: j.failReason || null,
  }));
}

export function parseLlmAnalysisJson(
  raw: string,
  jobs: AnalysisJob[],
): LlmAnalysisPayload | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    narrative?: unknown;
    recommendations?: unknown;
    dimensions?: unknown;
  };
  const narrative =
    typeof obj.narrative === "string" ? obj.narrative.trim() : "";
  if (!narrative) return null;
  const dimensions = parseDimensions(obj.dimensions);

  const byId = new Map(jobs.map((j) => [j.jobId, j]));
  const recs: DevRecommendation[] = [];
  const list = Array.isArray(obj.recommendations) ? obj.recommendations : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as RawRec;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    const ids = Array.isArray(r.evidenceJobIds)
      ? r.evidenceJobIds.filter((x): x is string => typeof x === "string")
      : [];
    const evidenceJobs = ids
      .map((id) => byId.get(id))
      .filter((j): j is AnalysisJob => Boolean(j))
      .slice(0, 3)
      .map((j) => ({
        jobId: j.jobId,
        issueIid: j.issueIid,
        title: j.title,
        url: j.url,
      }));
    recs.push({
      id:
        typeof r.id === "string" && r.id.trim()
          ? r.id.trim()
          : `llm-${recs.length + 1}`,
      dimension: isDim(r.dimension) ? r.dimension : "accuracy",
      severity:
        r.severity === "high" || r.severity === "low" ? r.severity : "medium",
      text,
      evidenceJobs,
    });
    if (recs.length >= 5) break;
  }
  if (!recs.length && !dimensions) return null;
  return { narrative, recommendations: recs, dimensions };
}

function buildPrompt(input: {
  ownerUsername: string;
  from: string;
  to: string;
  dimensions: SkillDimensions;
  previousDimensions: SkillDimensions;
  trend: Record<keyof SkillDimensions, number | null>;
  byTaskType: TaskTypeStats[];
  jobs: AnalysisJob[];
}): string {
  const snapshot = {
    owner: input.ownerUsername,
    window: { from: input.from, to: input.to },
    workHours: {
      timezone: "Asia/Ho_Chi_Minh",
      days: "Mon-Sat (T2-T7)",
      hours: "08:30-17:30",
      sundayOff: true,
    },
    formulaHint: input.dimensions,
    previousFormulaHint: input.previousDimensions,
    byTaskType: input.byTaskType,
    jobs: compactJobs(input.jobs),
  };

  return `Bạn là coach kỹ năng cho developer dùng Flow Auto WorkBench (agent Cursor trên GitLab issue).

Đọc JSON thống kê job bên dưới rồi TỰ CHẤM 5 trục kỹ năng và viết đánh giá bằng tiếng Việt.

Giờ làm việc: Thứ 2–Thứ 7, 08:30–17:30 (Asia/Ho_Chi_Minh). Chủ nhật không tính. workMin đã loại đêm/CN — dùng workMin (không dùng wallMin) khi chấm Tốc độ / Nhất quán.

Quy tắc:
- KHÔNG gọi tool, KHÔNG đọc file, KHÔNG sửa code. Chỉ trả lời từ JSON này.
- formulaHint chỉ là gợi ý thô — BẠN quyết định điểm 0–100 cuối cùng.
- Ước độ khó từng task (dễ / vừa / khó) từ title, loại (bug/feature/refactor/chore), số lần Run, token.
- Tốc độ: nhanh/chậm so với độ khó (task khó 1 ngày làm việc có thể vẫn tốt; task dễ kéo dài nhiều ngày làm việc thì kém).
- Chính xác: tỷ lệ succeeded/failed, retry, lỗi lặp.
- Phạm vi: loại task / domain hay fail.
- Nhất quán: độ ổn định thời gian làm việc (workMin) giữa task cùng độ khó.
- Hiệu quả: token so với độ khó (đừng phạt task khó dùng nhiều token).
- Khuyến nghị bằng tiếng Việt, gắn số liệu thật (fail %, loại, #iid, độ khó). Không nói chung chung.
- evidenceJobIds phải là jobId có trong JSON.
- Tối đa 5 khuyến nghị, ưu tiên 2–3 cái cụ thể.

Trả về DUY NHẤT một JSON:
{
  "dimensions": {
    "speed": 0,
    "accuracy": 0,
    "scope": 0,
    "consistency": 0,
    "efficiency": 0
  },
  "narrative": "2–4 câu tiếng Việt (xu hướng, mạnh/yếu, có xét độ khó)",
  "recommendations": [
    {
      "id": "slug-ngan",
      "dimension": "speed|accuracy|scope|consistency|efficiency",
      "severity": "high|medium|low",
      "text": "khuyến nghị tiếng Việt",
      "evidenceJobIds": ["jobId"]
    }
  ]
}

DATA:
${JSON.stringify(snapshot)}`;
}

async function collectText(
  run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>>,
): Promise<string> {
  let streamed = "";
  try {
    if (typeof run.stream === "function" && run.supports?.("stream") !== false) {
      for await (const message of run.stream()) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") streamed += block.text;
          }
        }
      }
    }
  } catch (err) {
    logger.warn("Dev analysis stream failed; wait()", { err: String(err) });
  }
  const result = await run.wait();
  if (result.status === "cancelled") {
    throw new AppError("Analysis cancelled", 400);
  }
  if (result.status === "error") {
    throw errorFromCursorRunStatus(
      result as {
        id: string;
        result?: string;
        durationMs?: number;
      },
      { label: "Dev evaluation" },
    );
  }
  return (result.result ?? streamed).trim();
}

export async function analyzeWithCursorSdk(input: {
  ownerUsername: string;
  from: string;
  to: string;
  dimensions: SkillDimensions;
  previousDimensions: SkillDimensions;
  trend: Record<keyof SkillDimensions, number | null>;
  byTaskType: TaskTypeStats[];
  jobs: AnalysisJob[];
}): Promise<LlmAnalysisPayload> {
  const rt = getRuntimeContext();
  const apiKey = rt?.cursorApiKey?.trim();
  if (!apiKey) {
    throw new AppError(
      "Cursor API key required (Settings → Cursor) to run performance analysis",
      400,
    );
  }
  const modelId = rt?.cursorModel?.trim() || "auto";
  const cwd = rt?.repoPath?.trim() || process.cwd();
  const prompt = buildPrompt(input);

  logger.info("Dev analysis Cursor SDK starting", {
    model: modelId,
    jobs: input.jobs.length,
    owner: input.ownerUsername,
  });

  try {
    const agent = await Agent.create({
      apiKey,
      model: { id: modelId },
      name: "stats-dev-eval",
      mcpServers: {},
      local: { cwd, settingSources: [] },
    });
    await using disposed = agent;
    logger.info("Dev analysis agent window", { agentId: disposed.agentId });
    const run = await disposed.send(prompt);
    logger.info("Dev analysis run started", {
      runId: run.id,
      agentId: disposed.agentId,
    });
    const text = await collectText(run);
    const parsed = parseLlmAnalysisJson(text, input.jobs);
    if (!parsed) {
      throw new AppError(
        "Agent reply was not valid evaluation JSON — try Analyze again",
        502,
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof CursorAgentError) {
      throw new AppError(
        formatCursorAgentFailure(err, err.message),
        err.isRetryable ? 503 : 400,
      );
    }
    throw err;
  }
}
