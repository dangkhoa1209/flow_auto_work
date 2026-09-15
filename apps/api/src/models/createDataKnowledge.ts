import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type { CreateDataKnowledgeDoc } from "../modules/createData/knowledge/types.js";

export type CreateDataKnowledgeModelDoc = CreateDataKnowledgeDoc &
  SoftDeleteFields;

export const CreateDataKnowledgeModel =
  createModel<CreateDataKnowledgeModelDoc>({
    collection: "ba_create_data_knowledge",
    softDelete: true,
    defaultSort: { updatedAt: -1 },
    idField: "id",
    parseId: (id) => id,
    indexes: [
      {
        keys: { baProjectId: 1 },
        options: { unique: true, softUnique: true },
      },
      { keys: { status: 1, updatedAt: -1 } },
    ],
  });
