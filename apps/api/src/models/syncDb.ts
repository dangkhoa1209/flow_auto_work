import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type { SyncDbJob } from "../modules/syncDb/types.js";

export type SyncDbJobDoc = SyncDbJob & SoftDeleteFields;

export const SyncDbJobModel = createModel<SyncDbJobDoc>({
  collection: "sync_db_jobs",
  softDelete: true,
  defaultSort: { createdAt: -1 },
  indexes: [
    { keys: { createdAt: -1 } },
    { keys: { status: 1, queuedAt: 1 } },
    { keys: { projectId: 1, createdAt: -1 } },
    { keys: { triggeredBy: 1, createdAt: -1 } },
  ],
});
