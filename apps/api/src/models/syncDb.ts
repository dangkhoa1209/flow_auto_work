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
    /**
     * Global concurrency = 1: at most one document with status "running".
     * Claim races fail with E11000 instead of double-spawn.
     */
    {
      keys: { status: 1 },
      options: {
        name: "sync_db_one_running",
        unique: true,
        partialFilterExpression: { status: "running", deleted: false },
      },
    },
    /**
     * At most one queued/running job per project (atomic vs check-then-insert).
     */
    {
      keys: { projectId: 1 },
      options: {
        name: "sync_db_one_active_per_project",
        unique: true,
        partialFilterExpression: {
          status: { $in: ["queued", "running"] },
          deleted: false,
        },
      },
    },
  ],
});
