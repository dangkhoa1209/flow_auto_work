import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type { DevAnalysisResult } from "../modules/stats/analyze.js";

export type StatsAnalysisCacheDoc = {
  _id: string;
  ownerUsername: string;
  workspaceProjectId: string | null;
  from: string;
  to: string;
  jobCount: number;
  labelConfigAt: string;
  engine: string;
  analyzedAt: string;
  result: DevAnalysisResult;
} & SoftDeleteFields;

export const StatsAnalysisCacheModel = createModel<StatsAnalysisCacheDoc>({
  collection: "stats_analysis_cache",
  softDelete: true,
  defaultSort: { analyzedAt: -1 },
  indexes: [{ keys: { analyzedAt: -1 } }],
});
