import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { CursorUsageModel } from "../../models/cursorUsage.js";
import { JobModel } from "../../models/job.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import {
  type CursorUsageKind,
  addUsageCounters,
  emptyUsageCounters,
  maybeDeltaFromCumulative,
  normalizeUsageFields,
  pickUsageFromCandidates,
} from "./usageNormalize.js";

export type PersistCursorUsageOpts = {
  kind: CursorUsageKind;
  userId?: string;
  jobId?: string;
  threadId?: string;
  messageId?: string;
  requirementId?: string;
  agentId?: string;
  runId?: string;
  model?: string;
  promptChars?: number;
  outputChars?: number;
  agent?: unknown;
  run?: unknown;
  result?: unknown;
  extraUsage?: unknown[];
};

function normUserId(raw?: string): string {
  return (raw || "").trim().toLowerCase();
}

export function resolveUsageUserId(explicit?: string): string {
  const fromRt = getRuntimeContext()?.gitlabUsername;
  return normUserId(explicit) || normUserId(fromRt) || "unknown";
}

async function resolveUsageUserIdWithJob(
  explicit?: string,
  jobId?: string,
): Promise<string> {
  const direct = resolveUsageUserId(explicit);
  if (direct !== "unknown") return direct;
  const id = jobId?.trim();
  if (!id) return "unknown";
  try {
    const job = await JobModel.findById(id);
    return normUserId(job?.ownerUsername) || "unknown";
  } catch {
    return "unknown";
  }
}

async function previousAgentCounters(agentId?: string) {
  const id = agentId?.trim();
  if (!id) return emptyUsageCounters();
  const prior = await CursorUsageModel.findMany({
    filter: { agentId: id },
    sort: { createdAt: 1 },
    limit: 2000,
  });
  const acc = emptyUsageCounters();
  for (const row of prior) addUsageCounters(acc, row);
  return acc;
}

async function readGetUsage(obj: unknown): Promise<unknown> {
  if (!obj || typeof obj !== "object") return null;
  const fn = (obj as { getUsage?: () => unknown }).getUsage;
  if (typeof fn !== "function") return null;
  try {
    return await Promise.resolve(fn.call(obj));
  } catch {
    return null;
  }
}

function pickId(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export async function persistCursorUsage(
  opts: PersistCursorUsageOpts,
): Promise<void> {
  try {
    const fromAgent = await readGetUsage(opts.agent);
    const fromRun = await readGetUsage(opts.run);
    const picked = pickUsageFromCandidates(
      opts.result,
      opts.run,
      opts.agent,
      fromAgent,
      fromRun,
      ...(opts.extraUsage ?? []),
    );
    const cfg = getConfig();
    const rawFields = normalizeUsageFields(picked, {
      promptChars: opts.promptChars,
      outputChars: opts.outputChars,
      usdPerMillionInput: cfg.STATS_USD_PER_MILLION_INPUT,
      usdPerMillionOutput: cfg.STATS_USD_PER_MILLION_OUTPUT,
    });

    const model = opts.model?.trim() || undefined;

    const agentId =
      opts.agentId ||
      pickId(opts.agent, ["agentId", "id"]) ||
      undefined;
    const runId =
      opts.runId ||
      pickId(opts.run, ["id", "runId"]) ||
      pickId(opts.result, ["id", "runId"]) ||
      undefined;

    const fields = maybeDeltaFromCumulative(
      rawFields,
      await previousAgentCounters(agentId),
    );
    if (fields.totalTokens <= 0 && fields.costCents <= 0) return;

    await CursorUsageModel.insert({
      id: `cue_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      userId: await resolveUsageUserIdWithJob(opts.userId, opts.jobId),
      kind: opts.kind,
      model,
      jobId: opts.jobId,
      threadId: opts.threadId,
      messageId: opts.messageId,
      requirementId: opts.requirementId,
      agentId,
      runId,
      ...fields,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn("Failed to persist Cursor usage", {
      kind: opts.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
