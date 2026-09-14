import { CreateDataBatchModel } from "../../models/createData.js";
import type { CreateDataBatch } from "./types.js";

export async function ensureCreateDataIndexes(): Promise<void> {
  await CreateDataBatchModel.ensureIndexes();
}

export async function insertCreateDataBatch(
  doc: CreateDataBatch,
): Promise<CreateDataBatch> {
  const row = await CreateDataBatchModel.insert(doc);
  return row as CreateDataBatch;
}

export async function getCreateDataBatch(
  id: string,
): Promise<CreateDataBatch | null> {
  const row = await CreateDataBatchModel.findById(id);
  return (row as CreateDataBatch | null) ?? null;
}

export async function updateCreateDataBatch(
  id: string,
  patch: Partial<CreateDataBatch>,
): Promise<CreateDataBatch | null> {
  const row = await CreateDataBatchModel.updateById(id, {
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  return (row as CreateDataBatch | null) ?? null;
}

export async function listCreateDataBatches(opts: {
  userId: string;
  baProjectId: string;
  limit?: number;
}): Promise<CreateDataBatch[]> {
  const rows = await CreateDataBatchModel.findMany({
    filter: {
      userId: opts.userId,
      baProjectId: opts.baProjectId,
    } as never,
    limit: opts.limit ?? 40,
    sort: { createdAt: -1 },
  });
  return rows as CreateDataBatch[];
}
