import { StatsAnalysisCacheModel } from "../../models/stats.js";
import type { DevAnalysisResult } from "./analyze.js";

function cacheKey(opts: {
  ownerUsername: string;
  workspaceProjectId?: string | null;
  from: string;
  to: string;
}): string {
  return `${opts.ownerUsername}|${opts.workspaceProjectId || "*"}|${opts.from}|${opts.to}`;
}

export async function getCachedDevAnalysis(opts: {
  ownerUsername: string;
  workspaceProjectId?: string | null;
  from: string;
  to: string;
  jobCount: number;
  labelConfigAt: string;
  engine: string;
}): Promise<DevAnalysisResult | null> {
  const doc = await StatsAnalysisCacheModel.findById(cacheKey(opts));
  if (!doc) return null;
  if (doc.jobCount !== opts.jobCount) return null;
  if (doc.labelConfigAt !== opts.labelConfigAt) return null;
  if (doc.engine !== opts.engine) return null;
  return { ...doc.result, cached: true, analyzedAt: doc.analyzedAt };
}

export async function saveDevAnalysisCache(opts: {
  ownerUsername: string;
  workspaceProjectId?: string | null;
  from: string;
  to: string;
  jobCount: number;
  labelConfigAt: string;
  engine: string;
  result: DevAnalysisResult;
}): Promise<void> {
  const _id = cacheKey(opts);
  const analyzedAt = opts.result.analyzedAt || new Date().toISOString();
  const col = await StatsAnalysisCacheModel.col();
  await col.updateOne(
    { _id },
    {
      $set: {
        ownerUsername: opts.ownerUsername,
        workspaceProjectId: opts.workspaceProjectId ?? null,
        from: opts.from,
        to: opts.to,
        jobCount: opts.jobCount,
        labelConfigAt: opts.labelConfigAt,
        engine: opts.engine,
        analyzedAt,
        result: opts.result,
        deleted: false,
        deletedAt: null,
      },
    },
    { upsert: true },
  );
}
