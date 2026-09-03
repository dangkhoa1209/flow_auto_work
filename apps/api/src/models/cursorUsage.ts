import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type { CursorUsageKind } from "../plugins/cursor/usageNormalize.js";

export type CursorUsageEvent = {
  id: string;
  userId: string;
  kind: CursorUsageKind;
  model?: string;
  jobId?: string;
  threadId?: string;
  messageId?: string;
  requirementId?: string;
  agentId?: string;
  runId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  chargedCents: number | null;
  estimatedCents: number;
  costCents: number;
  costSource: "sdk" | "estimated";
  fromSdk: boolean;
  createdAt: string;
};

export type CursorUsageDoc = CursorUsageEvent & SoftDeleteFields;

export const CursorUsageModel = createModel<CursorUsageDoc>({
  collection: "cursor_usage_events",
  softDelete: true,
  defaultSort: { createdAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    {
      keys: { id: 1 },
      options: { softUnique: true, name: "cue_id_soft_unique" },
    },
    { keys: { createdAt: -1 } },
    { keys: { userId: 1, createdAt: -1 } },
    { keys: { userId: 1, kind: 1, createdAt: -1 } },
    { keys: { kind: 1, createdAt: -1 } },
    { keys: { jobId: 1, createdAt: -1 } },
    { keys: { agentId: 1, createdAt: -1 } },
  ],
});
