import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type {
  CursorUsageKind,
  CursorUsageStatus,
} from "../plugins/cursor/usageNormalize.js";
import type { UserRole } from "../workspace/types.js";

export type CursorUsageEvent = {
  id: string;
  userId: string;
  /** Capability roles snapshot at record time (admin reporting). */
  roles?: UserRole[];
  kind: CursorUsageKind;
  /** Outcome of the Cursor action — defaults to ok for legacy rows. */
  status?: CursorUsageStatus;
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
    { keys: { roles: 1, createdAt: -1 } },
    { keys: { status: 1, createdAt: -1 } },
    { keys: { jobId: 1, createdAt: -1 } },
    { keys: { agentId: 1, createdAt: -1 } },
  ],
});
