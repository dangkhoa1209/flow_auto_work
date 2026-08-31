import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type {
  BaMessage,
  BaProject,
  BaRequirement,
  BaTaskDraft,
  BaThread,
  SystemSettings,
} from "../workspace/baStore.js";

export type BaProjectDoc = BaProject & SoftDeleteFields;
export type BaThreadDoc = BaThread & SoftDeleteFields;
export type BaMessageDoc = BaMessage & SoftDeleteFields;
export type BaRequirementDoc = BaRequirement & SoftDeleteFields;
export type BaTaskDraftDoc = BaTaskDraft & SoftDeleteFields;
export type SystemSettingsDoc = SystemSettings & SoftDeleteFields;

export const BaProjectModel = createModel<BaProjectDoc>({
  collection: "ba_projects",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    {
      keys: { slug: 1 },
      options: { softUnique: true, name: "slug_soft_unique" },
    },
  ],
});

export const BaThreadModel = createModel<BaThreadDoc>({
  collection: "ba_threads",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    { keys: { userId: 1, baProjectId: 1, updatedAt: -1 } },
  ],
});

export const BaMessageModel = createModel<BaMessageDoc>({
  collection: "ba_messages",
  softDelete: true,
  defaultSort: { createdAt: 1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [{ keys: { threadId: 1, createdAt: 1 } }],
});

export const BaRequirementModel = createModel<BaRequirementDoc>({
  collection: "ba_requirements",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    { keys: { userId: 1, baProjectId: 1, updatedAt: -1 } },
  ],
});

export const BaTaskDraftModel = createModel<BaTaskDraftDoc>({
  collection: "ba_task_drafts",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    { keys: { userId: 1, baProjectId: 1, updatedAt: -1 } },
    { keys: { requirementId: 1, createdAt: 1 } },
  ],
});

/** Singleton-ish settings — soft-delete rarely used; still model for consistency. */
export const SystemSettingsModel = createModel<SystemSettingsDoc>({
  collection: "system_settings",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  idField: "id",
  parseId: (id) => id,
});
