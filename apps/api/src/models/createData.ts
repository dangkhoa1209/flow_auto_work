import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type { CreateDataBatch } from "../modules/createData/types.js";

export type CreateDataBatchDoc = CreateDataBatch & SoftDeleteFields;

export const CreateDataBatchModel = createModel<CreateDataBatchDoc>({
  collection: "ba_create_data_batches",
  softDelete: true,
  defaultSort: { createdAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    { keys: { userId: 1, baProjectId: 1, createdAt: -1 } },
    { keys: { batchId: 1 } },
    { keys: { status: 1, createdAt: -1 } },
  ],
});
