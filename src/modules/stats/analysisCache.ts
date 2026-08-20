import { connectMongo, getDb } from "../../db/mongo.js";
import type { DevAnalysisResult } from "./analyze.js";

type CacheDoc = {
  _id: string;
  ownerUsername: string;
  workspaceProjectId: string | null;
  from: string;
  to: string;
  jobCount: number;
  labelConfigAt: string;
  analyzedAt: string;
  result: DevAnalysisResult;
};

function cacheKey(opts: {
  ownerUsername: string;
  workspaceProjectId?: string | null;
  from: string;
  to: string;
}): string {
  return `${opts.ownerUsername}|${opts.workspaceProjectId || "*"}|${opts.from}|${opts.to}`;
}

async function analysisCollection() {
  await connectMongo();
  return getDb().collection<CacheDoc>("stats_analysis_cache");
}

export async function getCachedDevAnalysis(opts: {
  ownerUsername: string;
  workspaceProjectId?: string | null;
  from: string;
  to: string;
  jobCount: number;
  labelConfigAt: string;
}): Promise<DevAnalysisResult | null> {
  const col = await analysisCollection();
  const doc = await col.findOne({ _id: cacheKey(opts) });
  if (!doc) return null;
  if (doc.jobCount !== opts.jobCount) return null;
  if (doc.labelConfigAt !== opts.labelConfigAt) return null;
  return { ...doc.result, cached: true, analyzedAt: doc.analyzedAt };
}

export async function saveDevAnalysisCache(opts: {
  ownerUsername: string;
  workspaceProjectId?: string | null;
  from: string;
  to: string;
  jobCount: number;
  labelConfigAt: string;
  result: DevAnalysisResult;
}): Promise<void> {
  const col = await analysisCollection();
  const key = cacheKey(opts);
  await col.updateOne(
    { _id: key },
    {
      $set: {
        _id: key,
        ownerUsername: opts.ownerUsername,
        workspaceProjectId: opts.workspaceProjectId ?? null,
        from: opts.from,
        to: opts.to,
        jobCount: opts.jobCount,
        labelConfigAt: opts.labelConfigAt,
        analyzedAt: opts.result.analyzedAt,
        result: opts.result,
      },
    },
    { upsert: true },
  );
}
