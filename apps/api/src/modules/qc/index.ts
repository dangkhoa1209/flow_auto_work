/**
 * QC domain module — ownership rules + FS uploads.
 * Persistence: models/qc.ts (createModel + soft-delete).
 */
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Sort } from "mongodb";
import {
  QcFlowModel,
  QcProjectModel,
  QcSampleFileModel,
  QcTestCaseModel,
  slugId,
  type QcExecutionPlanItem,
  type QcFlowDoc,
  type QcFlowStep,
  type QcProjectDoc,
  type QcSampleFileDoc,
  type QcTestCaseDoc,
} from "../../models/qc.js";
import { purgeSoftDeleted } from "../../models/base.js";
import { getRepoRoot } from "../../repoRoot.js";
import { AppError } from "../../utils/AppError.js";

export type {
  QcExecutionPlanItem,
  QcFlowDoc,
  QcFlowStep,
  QcProjectDoc,
  QcSampleFileDoc,
  QcSelectorContext,
  QcStepAction,
  QcTestCaseDoc,
} from "../../models/qc.js";
export { slugId } from "../../models/qc.js";

function uploadsRoot(): string {
  return path.resolve(getRepoRoot(), "uploads", "qc");
}

async function assertProjectOwned(
  qcProjectId: string,
  username: string,
): Promise<QcProjectDoc> {
  const doc = await QcProjectModel.findById(qcProjectId);
  if (!doc) throw new AppError("QC project not found", 404);
  if (doc.ownerUsername !== username) {
    throw new AppError("QC project access denied", 403);
  }
  return doc;
}

export type ListOpts = {
  sort?: Sort;
  skip?: number;
  limit?: number;
};

export async function listQcProjects(
  username: string,
  list?: ListOpts,
): Promise<{ rows: QcProjectDoc[]; count: number }> {
  const filter = { ownerUsername: username };
  const [rows, count] = await Promise.all([
    QcProjectModel.findMany({
      filter,
      sort: list?.sort,
      skip: list?.skip,
      limit: list?.limit,
    }),
    QcProjectModel.count({ filter }),
  ]);
  return { rows, count };
}

export async function createQcProject(opts: {
  username: string;
  name: string;
  targetBaseUrl: string;
}): Promise<QcProjectDoc> {
  const name = opts.name.trim();
  const targetBaseUrl = opts.targetBaseUrl.trim().replace(/\/$/, "");
  if (!name) throw new AppError("name required", 400);
  if (!targetBaseUrl) throw new AppError("targetBaseUrl required", 400);
  const now = new Date().toISOString();
  await purgeSoftDeleted(await QcProjectModel.col(), {
    ownerUsername: opts.username,
    name,
  });
  return QcProjectModel.insert({
    _id: slugId("qcp", name),
    ownerUsername: opts.username,
    name,
    targetBaseUrl,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateQcProject(opts: {
  username: string;
  projectId: string;
  name?: string;
  targetBaseUrl?: string;
}): Promise<QcProjectDoc> {
  const existing = await assertProjectOwned(opts.projectId, opts.username);
  const patch: Partial<QcProjectDoc> = {
    updatedAt: new Date().toISOString(),
  };
  if (opts.name !== undefined) patch.name = opts.name.trim() || existing.name;
  if (opts.targetBaseUrl !== undefined) {
    patch.targetBaseUrl =
      opts.targetBaseUrl.trim().replace(/\/$/, "") || existing.targetBaseUrl;
  }
  const updated = await QcProjectModel.updateById(existing._id, patch);
  if (!updated) throw new AppError("QC project not found", 404);
  return updated;
}

export async function deleteQcProject(opts: {
  username: string;
  projectId: string;
}): Promise<{ ok: true }> {
  await assertProjectOwned(opts.projectId, opts.username);
  const samples = await QcSampleFileModel.findMany({
    filter: { qcProjectId: opts.projectId },
  });
  for (const sample of samples) {
    try {
      await unlink(sample.storagePath);
    } catch {
      /* ignore missing */
    }
  }
  await QcFlowModel.softDeleteMany({ qcProjectId: opts.projectId });
  await QcTestCaseModel.softDeleteMany({ qcProjectId: opts.projectId });
  await QcSampleFileModel.softDeleteMany({ qcProjectId: opts.projectId });
  await QcProjectModel.softDeleteById(opts.projectId);
  return { ok: true };
}

export async function listQcFlows(opts: {
  username: string;
  qcProjectId: string;
  list?: ListOpts;
}): Promise<{ rows: QcFlowDoc[]; count: number }> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  const filter = { qcProjectId: opts.qcProjectId };
  const [rows, count] = await Promise.all([
    QcFlowModel.findMany({
      filter,
      sort: opts.list?.sort,
      skip: opts.list?.skip,
      limit: opts.list?.limit,
    }),
    QcFlowModel.count({ filter }),
  ]);
  return { rows, count };
}

export async function getQcFlow(opts: {
  username: string;
  flowId: string;
}): Promise<QcFlowDoc> {
  const doc = await QcFlowModel.findById(opts.flowId);
  if (!doc) throw new AppError("Flow not found", 404);
  await assertProjectOwned(doc.qcProjectId, opts.username);
  return doc;
}

export async function createQcFlow(opts: {
  username: string;
  qcProjectId: string;
  name: string;
  steps?: QcFlowStep[];
}): Promise<QcFlowDoc> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  const name = opts.name.trim();
  if (!name) throw new AppError("name required", 400);
  const now = new Date().toISOString();
  await purgeSoftDeleted(await QcFlowModel.col(), {
    qcProjectId: opts.qcProjectId,
    name,
  });
  return QcFlowModel.insert({
    _id: slugId("flow", name),
    qcProjectId: opts.qcProjectId,
    ownerUsername: opts.username,
    name,
    steps: Array.isArray(opts.steps) ? opts.steps : [],
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateQcFlow(opts: {
  username: string;
  flowId: string;
  name?: string;
  steps?: QcFlowStep[];
}): Promise<QcFlowDoc> {
  const existing = await getQcFlow({
    username: opts.username,
    flowId: opts.flowId,
  });
  const patch: Partial<QcFlowDoc> = {
    updatedAt: new Date().toISOString(),
  };
  if (opts.name !== undefined) patch.name = opts.name.trim() || existing.name;
  if (opts.steps !== undefined) patch.steps = opts.steps;
  const updated = await QcFlowModel.updateById(existing._id, patch);
  if (!updated) throw new AppError("Flow not found", 404);
  return updated;
}

export async function deleteQcFlow(opts: {
  username: string;
  flowId: string;
}): Promise<{ ok: true }> {
  await getQcFlow(opts);
  await QcFlowModel.softDeleteById(opts.flowId);
  return { ok: true };
}

export async function listQcTestCases(opts: {
  username: string;
  qcProjectId: string;
  list?: ListOpts;
}): Promise<{ rows: QcTestCaseDoc[]; count: number }> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  const filter = { qcProjectId: opts.qcProjectId };
  const [rows, count] = await Promise.all([
    QcTestCaseModel.findMany({
      filter,
      sort: opts.list?.sort,
      skip: opts.list?.skip,
      limit: opts.list?.limit,
    }),
    QcTestCaseModel.count({ filter }),
  ]);
  return { rows, count };
}

export async function getQcTestCase(opts: {
  username: string;
  testCaseId: string;
}): Promise<QcTestCaseDoc> {
  const doc = await QcTestCaseModel.findById(opts.testCaseId);
  if (!doc) throw new AppError("Test case not found", 404);
  await assertProjectOwned(doc.qcProjectId, opts.username);
  return doc;
}

export async function createQcTestCase(opts: {
  username: string;
  qcProjectId: string;
  name: string;
  loopCount?: number;
  executionPlan?: QcExecutionPlanItem[];
}): Promise<QcTestCaseDoc> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  const name = opts.name.trim();
  if (!name) throw new AppError("name required", 400);
  const now = new Date().toISOString();
  await purgeSoftDeleted(await QcTestCaseModel.col(), {
    qcProjectId: opts.qcProjectId,
    name,
  });
  return QcTestCaseModel.insert({
    _id: slugId("tc", name),
    qcProjectId: opts.qcProjectId,
    ownerUsername: opts.username,
    name,
    loopCount: Math.max(1, Number(opts.loopCount) || 1),
    executionPlan: Array.isArray(opts.executionPlan) ? opts.executionPlan : [],
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateQcTestCase(opts: {
  username: string;
  testCaseId: string;
  name?: string;
  loopCount?: number;
  executionPlan?: QcExecutionPlanItem[];
}): Promise<QcTestCaseDoc> {
  const existing = await getQcTestCase({
    username: opts.username,
    testCaseId: opts.testCaseId,
  });
  const patch: Partial<QcTestCaseDoc> = {
    updatedAt: new Date().toISOString(),
  };
  if (opts.name !== undefined) patch.name = opts.name.trim() || existing.name;
  if (opts.loopCount !== undefined) {
    patch.loopCount = Math.max(1, Number(opts.loopCount) || 1);
  }
  if (opts.executionPlan !== undefined) {
    patch.executionPlan = opts.executionPlan;
  }
  const updated = await QcTestCaseModel.updateById(existing._id, patch);
  if (!updated) throw new AppError("Test case not found", 404);
  return updated;
}

export async function deleteQcTestCase(opts: {
  username: string;
  testCaseId: string;
}): Promise<{ ok: true }> {
  await getQcTestCase(opts);
  await QcTestCaseModel.softDeleteById(opts.testCaseId);
  return { ok: true };
}

export async function listQcSampleFiles(opts: {
  username: string;
  qcProjectId: string;
  list?: ListOpts;
}): Promise<{ rows: QcSampleFileDoc[]; count: number }> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  const filter = { qcProjectId: opts.qcProjectId };
  const [rows, count] = await Promise.all([
    QcSampleFileModel.findMany({
      filter,
      sort: opts.list?.sort ?? { createdAt: -1 },
      skip: opts.list?.skip,
      limit: opts.list?.limit,
    }),
    QcSampleFileModel.count({ filter }),
  ]);
  return { rows, count };
}

export async function saveQcSampleFile(opts: {
  username: string;
  qcProjectId: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<QcSampleFileDoc> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  const id = slugId("file", opts.originalName);
  const dir = path.join(uploadsRoot(), opts.qcProjectId);
  await mkdir(dir, { recursive: true });
  const safeName = opts.originalName.replace(/[/\\]/g, "_").slice(0, 120);
  const storagePath = path.join(dir, `${id}__${safeName}`);
  await writeFile(storagePath, opts.buffer);
  const now = new Date().toISOString();
  return QcSampleFileModel.insert({
    _id: id,
    qcProjectId: opts.qcProjectId,
    ownerUsername: opts.username,
    originalName: opts.originalName,
    mimeType: opts.mimeType || "application/octet-stream",
    storagePath,
    size: opts.buffer.length,
    createdAt: now,
  });
}

export async function getQcSampleFileStream(opts: {
  username: string;
  fileId: string;
}): Promise<{ doc: QcSampleFileDoc; stream: NodeJS.ReadableStream }> {
  const doc = await QcSampleFileModel.findById(opts.fileId);
  if (!doc) throw new AppError("Sample file not found", 404);
  await assertProjectOwned(doc.qcProjectId, opts.username);
  if (!existsSync(doc.storagePath)) {
    throw new AppError("Sample file missing on disk", 404);
  }
  return { doc, stream: createReadStream(doc.storagePath) };
}

export async function deleteQcSampleFile(opts: {
  username: string;
  fileId: string;
}): Promise<{ ok: true }> {
  const doc = await QcSampleFileModel.findById(opts.fileId);
  if (!doc) throw new AppError("Sample file not found", 404);
  await assertProjectOwned(doc.qcProjectId, opts.username);
  try {
    await unlink(doc.storagePath);
  } catch {
    /* ignore missing */
  }
  await QcSampleFileModel.softDeleteById(opts.fileId);
  return { ok: true };
}
