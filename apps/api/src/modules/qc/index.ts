import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { type Collection } from "mongodb";
import { connectMongo } from "../../db/mongo.js";
import { getRepoRoot } from "../../repoRoot.js";
import { AppError } from "../../utils/AppError.js";
import {
  slugId,
  type QcFlowDoc,
  type QcFlowStep,
  type QcProjectDoc,
  type QcSampleFileDoc,
  type QcTestCaseDoc,
  type QcExecutionPlanItem,
} from "./types.js";

let indexesReady = false;

async function ensureQcIndexes(): Promise<void> {
  if (indexesReady) return;
  const db = await connectMongo();
  await db.collection("qc_projects").createIndex({ ownerUsername: 1 });
  await db.collection("qc_flows").createIndex({ qcProjectId: 1, updatedAt: -1 });
  await db
    .collection("qc_test_cases")
    .createIndex({ qcProjectId: 1, updatedAt: -1 });
  await db
    .collection("qc_sample_files")
    .createIndex({ qcProjectId: 1, createdAt: -1 });
  indexesReady = true;
}

async function projects(): Promise<Collection<QcProjectDoc>> {
  await ensureQcIndexes();
  return (await connectMongo()).collection<QcProjectDoc>("qc_projects");
}

async function flows(): Promise<Collection<QcFlowDoc>> {
  await ensureQcIndexes();
  return (await connectMongo()).collection<QcFlowDoc>("qc_flows");
}

async function testCases(): Promise<Collection<QcTestCaseDoc>> {
  await ensureQcIndexes();
  return (await connectMongo()).collection<QcTestCaseDoc>("qc_test_cases");
}

async function sampleFiles(): Promise<Collection<QcSampleFileDoc>> {
  await ensureQcIndexes();
  return (await connectMongo()).collection<QcSampleFileDoc>("qc_sample_files");
}

function uploadsRoot(): string {
  return path.resolve(getRepoRoot(), "uploads", "qc");
}

async function assertProjectOwned(
  qcProjectId: string,
  username: string,
): Promise<QcProjectDoc> {
  const doc = await (await projects()).findOne({ _id: qcProjectId });
  if (!doc) throw new AppError("QC project not found", 404);
  if (doc.ownerUsername !== username) {
    throw new AppError("QC project access denied", 403);
  }
  return doc;
}

export async function listQcProjects(username: string): Promise<QcProjectDoc[]> {
  return (await projects())
    .find({ ownerUsername: username })
    .sort({ updatedAt: -1 })
    .toArray();
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
  const doc: QcProjectDoc = {
    _id: slugId("qcp", name),
    ownerUsername: opts.username,
    name,
    targetBaseUrl,
    createdAt: now,
    updatedAt: now,
  };
  await (await projects()).insertOne(doc);
  return doc;
}

export async function updateQcProject(opts: {
  username: string;
  projectId: string;
  name?: string;
  targetBaseUrl?: string;
}): Promise<QcProjectDoc> {
  const existing = await assertProjectOwned(opts.projectId, opts.username);
  if (opts.name !== undefined) existing.name = opts.name.trim() || existing.name;
  if (opts.targetBaseUrl !== undefined) {
    existing.targetBaseUrl =
      opts.targetBaseUrl.trim().replace(/\/$/, "") || existing.targetBaseUrl;
  }
  existing.updatedAt = new Date().toISOString();
  await (await projects()).updateOne({ _id: existing._id }, { $set: existing });
  return existing;
}

export async function deleteQcProject(opts: {
  username: string;
  projectId: string;
}): Promise<{ ok: true }> {
  await assertProjectOwned(opts.projectId, opts.username);
  await (await flows()).deleteMany({ qcProjectId: opts.projectId });
  await (await testCases()).deleteMany({ qcProjectId: opts.projectId });
  await (await sampleFiles()).deleteMany({ qcProjectId: opts.projectId });
  await (await projects()).deleteOne({ _id: opts.projectId });
  return { ok: true };
}

export async function listQcFlows(opts: {
  username: string;
  qcProjectId: string;
}): Promise<QcFlowDoc[]> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  return (await flows())
    .find({ qcProjectId: opts.qcProjectId })
    .sort({ updatedAt: -1 })
    .toArray();
}

export async function getQcFlow(opts: {
  username: string;
  flowId: string;
}): Promise<QcFlowDoc> {
  const doc = await (await flows()).findOne({ _id: opts.flowId });
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
  const doc: QcFlowDoc = {
    _id: slugId("flow", name),
    qcProjectId: opts.qcProjectId,
    ownerUsername: opts.username,
    name,
    steps: Array.isArray(opts.steps) ? opts.steps : [],
    createdAt: now,
    updatedAt: now,
  };
  await (await flows()).insertOne(doc);
  return doc;
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
  if (opts.name !== undefined) existing.name = opts.name.trim() || existing.name;
  if (opts.steps !== undefined) existing.steps = opts.steps;
  existing.updatedAt = new Date().toISOString();
  await (await flows()).updateOne({ _id: existing._id }, { $set: existing });
  return existing;
}

export async function deleteQcFlow(opts: {
  username: string;
  flowId: string;
}): Promise<{ ok: true }> {
  await getQcFlow(opts);
  await (await flows()).deleteOne({ _id: opts.flowId });
  return { ok: true };
}

export async function listQcTestCases(opts: {
  username: string;
  qcProjectId: string;
}): Promise<QcTestCaseDoc[]> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  return (await testCases())
    .find({ qcProjectId: opts.qcProjectId })
    .sort({ updatedAt: -1 })
    .toArray();
}

export async function getQcTestCase(opts: {
  username: string;
  testCaseId: string;
}): Promise<QcTestCaseDoc> {
  const doc = await (await testCases()).findOne({ _id: opts.testCaseId });
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
  const doc: QcTestCaseDoc = {
    _id: slugId("tc", name),
    qcProjectId: opts.qcProjectId,
    ownerUsername: opts.username,
    name,
    loopCount: Math.max(1, Number(opts.loopCount) || 1),
    executionPlan: Array.isArray(opts.executionPlan) ? opts.executionPlan : [],
    createdAt: now,
    updatedAt: now,
  };
  await (await testCases()).insertOne(doc);
  return doc;
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
  if (opts.name !== undefined) existing.name = opts.name.trim() || existing.name;
  if (opts.loopCount !== undefined) {
    existing.loopCount = Math.max(1, Number(opts.loopCount) || 1);
  }
  if (opts.executionPlan !== undefined) {
    existing.executionPlan = opts.executionPlan;
  }
  existing.updatedAt = new Date().toISOString();
  await (await testCases()).updateOne(
    { _id: existing._id },
    { $set: existing },
  );
  return existing;
}

export async function deleteQcTestCase(opts: {
  username: string;
  testCaseId: string;
}): Promise<{ ok: true }> {
  await getQcTestCase(opts);
  await (await testCases()).deleteOne({ _id: opts.testCaseId });
  return { ok: true };
}

export async function listQcSampleFiles(opts: {
  username: string;
  qcProjectId: string;
}): Promise<QcSampleFileDoc[]> {
  await assertProjectOwned(opts.qcProjectId, opts.username);
  return (await sampleFiles())
    .find({ qcProjectId: opts.qcProjectId })
    .sort({ createdAt: -1 })
    .toArray();
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
  const doc: QcSampleFileDoc = {
    _id: id,
    qcProjectId: opts.qcProjectId,
    ownerUsername: opts.username,
    originalName: opts.originalName,
    mimeType: opts.mimeType || "application/octet-stream",
    storagePath,
    size: opts.buffer.length,
    createdAt: now,
  };
  await (await sampleFiles()).insertOne(doc);
  return doc;
}

export async function getQcSampleFileStream(opts: {
  username: string;
  fileId: string;
}): Promise<{ doc: QcSampleFileDoc; stream: NodeJS.ReadableStream }> {
  const doc = await (await sampleFiles()).findOne({ _id: opts.fileId });
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
  const doc = await (await sampleFiles()).findOne({ _id: opts.fileId });
  if (!doc) throw new AppError("Sample file not found", 404);
  await assertProjectOwned(doc.qcProjectId, opts.username);
  try {
    await unlink(doc.storagePath);
  } catch {
    /* ignore missing */
  }
  await (await sampleFiles()).deleteOne({ _id: opts.fileId });
  return { ok: true };
}
