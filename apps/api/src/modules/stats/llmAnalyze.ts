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

export const DEV_ANALYSIS_ENGINE = "cursor-sdk-v3";

const DIMS = [
  "speed",
  "accuracy",
  "scope",
  "consistency",
  "efficiency",
] as const;

/** Agent may return EN keys or VI aliases. */
const DIM_ALIASES: Record<string, (typeof DIMS)[number]> = {
  speed: "speed",
  tocdo: "speed",
  todo: "speed",
  accuracy: "accuracy",
  chinhxac: "accuracy",
  scope: "scope",
  phamvi: "scope",
  consistency: "consistency",
  nhatquan: "consistency",
  efficiency: "efficiency",
  hieuqua: "efficiency",
};

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
  title?: unknown;
  detail?: unknown;
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

/** Accept flat number or `{ score }` / `{ score, label, reasoning }`. */
function scoreFromDimValue(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" || typeof raw === "string") {
    return clampScore(raw);
  }
  if (typeof raw === "object" && "score" in raw) {
    return clampScore((raw as { score: unknown }).score);
  }
  return null;
}

function pickDim(
  o: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const k of keys) {
    if (k in o) {
      const s = scoreFromDimValue(o[k]);
      if (s != null) return s;
    }
  }
  return null;
}

function parseDimensions(raw: unknown): SkillDimensions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const speed = pickDim(o, "speed", "tocDo", "toDo", "tocdo", "todo");
  const accuracy = pickDim(o, "accuracy", "chinhXac", "chinhxac");
  const scope = pickDim(o, "scope", "phamVi", "phamvi");
  const consistency = pickDim(o, "consistency", "nhatQuan", "nhatquan");
  const efficiency = pickDim(o, "efficiency", "hieuQua", "hieuqua");
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
  if (typeof v !== "string") return false;
  const key = DIM_ALIASES[v.trim().toLowerCase()];
  return Boolean(key);
}

function toDim(v: unknown): DevRecommendation["dimension"] {
  if (typeof v !== "string") return "accuracy";
  return DIM_ALIASES[v.trim().toLowerCase()] ?? "accuracy";
}

function compactJobs(jobs: AnalysisJob[]) {
  const failed = jobs.filter((j) => j.status === "failed");
  const rest = jobs.filter((j) => j.status !== "failed");
  const picked = [...failed, ...rest].slice(0, MAX_JOBS_IN_PROMPT);
  return picked.map((j) => {
    const workMin =
      j.workDurationMs != null && j.workDurationMs > 0
        ? Math.round(j.workDurationMs / 60_000)
        : null;
    const wallMin =
      j.durationMs != null && j.durationMs > 0
        ? Math.round(j.durationMs / 60_000)
        : null;
    return {
      jobId: j.jobId,
      iid: j.issueIid,
      title: j.title.slice(0, 120),
      type: j.taskType === "other" ? "unknown" : j.taskType,
      status: j.status,
      runs: j.runCount || 0,
      tokens: j.tokensTotal || 0,
      workMin,
      wallMin,
      failReason: j.failReason || null,
    };
  });
}

function recText(r: RawRec): string {
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const detail = typeof r.detail === "string" ? r.detail.trim() : "";
  const text = typeof r.text === "string" ? r.text.trim() : "";
  if (title && detail) return `${title}: ${detail}`;
  return text || detail || title;
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
    const text = recText(r);
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
    const idFromTitle =
      typeof r.title === "string" && r.title.trim()
        ? r.title
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9à-ỹ]+/gi, "-")
            .slice(0, 40)
        : "";
    recs.push({
      id:
        typeof r.id === "string" && r.id.trim()
          ? r.id.trim()
          : idFromTitle || `llm-${recs.length + 1}`,
      dimension: isDim(r.dimension) ? toDim(r.dimension) : "accuracy",
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

  return `Bạn là coach kỹ năng cho developer dùng Flow Auto WorkBench (agent Cursor chạy trên GitLab issue).
Nhiệm vụ: đọc JSON thống kê job bên dưới, TỰ CHẤM 5 trục kỹ năng (0–100) và viết đánh giá bằng tiếng Việt.

## Ngữ cảnh thời gian
Giờ làm việc: Thứ 2–Thứ 7, 08:30–17:30 (Asia/Ho_Chi_Minh). Chủ nhật không tính.
\`workMin\` = phút làm việc đã loại đêm/CN (dùng cho Tốc độ & Nhất quán).
\`wallMin\` = phút thực tế trôi qua (KHÔNG dùng để chấm điểm, chỉ tham khảo nếu cần giải thích chênh lệch bất thường).

## Input JSON — schema kỳ vọng (đã được hệ thống cung cấp trong DATA)
Mỗi job có: jobId, iid, title, type (bug|feature|refactor|chore|unknown), status (succeeded|failed|running|queued|awaiting_handoff|…), runs, tokens, workMin, wallMin, failReason (optional).
formulaHint / previousFormulaHint = gợi ý điểm thô — KHÔNG bắt buộc theo.
byTaskType = tổng hợp theo loại task (tham khảo).

Nếu thiếu field không bắt buộc: bỏ qua, không suy diễn bừa.
Nếu jobs rỗng hoặc không có job terminal (succeeded/failed): narrative giải thích "không đủ dữ liệu để chấm điểm", dimensions để null, recommendations [].
Nếu workMin <= 0 hoặc (wallMin khác null và workMin > wallMin): loại job đó khỏi Tốc độ/Nhất quán, vẫn tính Chính xác/Phạm vi/Hiệu quả nếu status hợp lệ; ghi chú trong narrative.

## Quy tắc bắt buộc
- KHÔNG gọi tool, KHÔNG đọc file, KHÔNG sửa code. Chỉ dùng dữ liệu trong JSON DATA.
- formulaHint chỉ là gợi ý thô — BẠN tự quyết điểm cuối cùng, không copy y nguyên.
- Bỏ qua job status đang chạy / chờ (running, queued, awaiting_handoff, …) khi chấm điểm; có thể nhắc trong narrative nếu số lượng đáng kể. Chỉ dùng succeeded/failed để kết luận.

### Ước độ khó (dễ / vừa / khó)
Suy từ: loại task (refactor/feature thường khó hơn chore/bug nhỏ), từ khóa title (migrate, redesign → khó hơn fix typo, update config), số lần runs, token.
Ghi rõ cách suy luận độ khó trong narrative cho job dùng làm evidence.

### Thang điểm tham chiếu (5 trục)
- 90–100: xuất sắc
- 75–89: tốt, vài điểm nhỏ cần cải thiện
- 55–74: trung bình, có vấn đề rõ
- 30–54: yếu, nhiều vấn đề lặp
- 0–29: kém, cần can thiệp ngay

### 5 trục
1. **Tốc độ (speed)** — workMin so với độ khó. Task khó 1 ngày làm việc vẫn có thể tốt; task dễ kéo dài nhiều ngày là kém.
2. **Chính xác (accuracy)** — tỷ lệ succeeded/failed, runs > 1, lỗi lặp (failReason / type).
3. **Phạm vi (scope)** — loại task nào hay fail/retry; loại nào xử lý tốt.
4. **Nhất quán (consistency)** — ổn định workMin giữa job cùng độ khó. Cần ≥2 job cùng độ khó; nếu thiếu mẫu: ghi "chưa đủ dữ liệu để đánh giá nhất quán", score có thể thấp trung bình hoặc null không đoán bừa.
5. **Hiệu quả (efficiency)** — token so với độ khó; KHÔNG phạt task khó dùng nhiều token.

### Khuyến nghị
- Tối đa 5, ưu tiên 2–3 cái actionable.
- Mỗi cái PHẢI gắn số liệu thật (fail %, loại, #iid, độ khó, workMin nếu liên quan).
- evidenceJobIds chỉ chứa jobId có trong DATA.
- Không viết chung chung không số liệu.

## Output — DUY NHẤT một JSON (không markdown ngoài JSON)
Dùng đúng key tiếng Anh cho dimensions (radar UI): speed, accuracy, scope, consistency, efficiency.
Mỗi trục là object { "score": number|null, "label": string, "reasoning": string }.

{
  "dimensions": {
    "speed":        { "score": 0, "label": "…", "reasoning": "…" },
    "accuracy":     { "score": 0, "label": "…", "reasoning": "…" },
    "scope":        { "score": 0, "label": "…", "reasoning": "…" },
    "consistency":  { "score": 0, "label": "…", "reasoning": "…" },
    "efficiency":   { "score": 0, "label": "…", "reasoning": "…" }
  },
  "narrative": "≤~200 từ, tiếng Việt, gắn số liệu cụ thể",
  "recommendations": [
    {
      "id": "slug-ngan",
      "dimension": "speed|accuracy|scope|consistency|efficiency",
      "severity": "high|medium|low",
      "title": "tiêu đề ngắn",
      "detail": "chi tiết gắn số liệu (#iid, fail %, loại, độ khó)",
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
  const prompt = buildPrompt({
    ownerUsername: input.ownerUsername,
    from: input.from,
    to: input.to,
    dimensions: input.dimensions,
    previousDimensions: input.previousDimensions,
    byTaskType: input.byTaskType,
    jobs: input.jobs,
  });

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
