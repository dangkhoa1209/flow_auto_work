import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type { BuildJob, WhitelistedScript } from "../modules/devops/types.js";

export type BuildJobDoc = BuildJob & SoftDeleteFields;

export type BuildScriptDoc = WhitelistedScript & {
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
} & SoftDeleteFields;

export const BuildJobModel = createModel<BuildJobDoc>({
  collection: "build_jobs",
  softDelete: true,
  defaultSort: { createdAt: -1 },
  indexes: [
    { keys: { createdAt: -1 } },
    { keys: { status: 1, queuedAt: 1 } },
    { keys: { scriptId: 1, createdAt: -1 } },
    { keys: { triggeredBy: 1, createdAt: -1 } },
  ],
});

export const BuildScriptModel = createModel<BuildScriptDoc>({
  collection: "build_scripts",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  indexes: [
    {
      keys: { id: 1 },
      options: { softUnique: true, name: "id_soft_unique" },
    },
  ],
});
