import { MongoClient, type Collection, type Db } from "mongodb";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import type { JobRecord, JobStatus } from "../types.js";

export type JobDoc = JobRecord & {
  _id: string;
  source?: string;
};

export type NoteDoc = {
  _id?: string;
  jobId?: string;
  issueIid: number;
  projectPath: string;
  body: string;
  createdAt: string;
};

export type ChatMessageDoc = {
  _id?: string;
  jobId?: string;
  issueIid: number;
  role: "user" | "agent" | "system";
  kind: "clarify" | "qa" | "note";
  body: string;
  createdAt: string;
};

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;
  const uri = getConfig().MONGODB_URI;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(getConfig().MONGODB_DB);
  await db.collection("jobs").createIndex({ "issue.issueIid": 1, updatedAt: -1 });
  await db.collection("jobs").createIndex({ status: 1, updatedAt: -1 });
  await db.collection("notes").createIndex({ issueIid: 1, createdAt: -1 });
  await db.collection("notes").createIndex({ jobId: 1, createdAt: -1 });
  await db.collection("chat").createIndex({ jobId: 1, createdAt: 1 });
  await db.collection("chat").createIndex({ issueIid: 1, createdAt: 1 });
  logger.info("MongoDB connected", {
    uri: uri.replace(/\/\/.*@/, "//***@"),
    db: getConfig().MONGODB_DB,
  });
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

function jobs(): Collection<JobDoc> {
  if (!db) throw new Error("MongoDB not connected");
  return db.collection<JobDoc>("jobs");
}

function notes(): Collection<NoteDoc> {
  if (!db) throw new Error("MongoDB not connected");
  return db.collection<NoteDoc>("notes");
}

function chat(): Collection<ChatMessageDoc> {
  if (!db) throw new Error("MongoDB not connected");
  return db.collection<ChatMessageDoc>("chat");
}

export async function upsertJobDoc(
  job: JobRecord,
  extra?: { source?: string },
): Promise<void> {
  await connectMongo();
  // Never $set `source` together with $setOnInsert.source — Mongo conflict.
  const { source: _ignoredSource, ...jobFields } = job as JobRecord & {
    source?: string;
  };
  const setDoc: Record<string, unknown> = {
    ...jobFields,
    _id: job.id,
  };

  if (extra?.source) {
    setDoc.source = extra.source;
    await jobs().updateOne(
      { _id: job.id },
      { $set: setDoc },
      { upsert: true },
    );
    return;
  }

  await jobs().updateOne(
    { _id: job.id },
    { $set: setDoc, $setOnInsert: { source: "unknown" } },
    { upsert: true },
  );
}

export async function listJobDocs(opts?: {
  limit?: number;
  status?: JobStatus;
}): Promise<JobDoc[]> {
  await connectMongo();
  const filter = opts?.status ? { status: opts.status } : {};
  return jobs()
    .find(filter)
    .sort({ updatedAt: -1 })
    .limit(opts?.limit ?? 50)
    .toArray();
}

export async function getJobDoc(id: string): Promise<JobDoc | null> {
  await connectMongo();
  return jobs().findOne({ _id: id });
}

export async function addNote(input: {
  jobId?: string;
  issueIid: number;
  projectPath: string;
  body: string;
}): Promise<NoteDoc> {
  await connectMongo();
  const doc: NoteDoc = {
    jobId: input.jobId,
    issueIid: input.issueIid,
    projectPath: input.projectPath,
    body: input.body.trim(),
    createdAt: new Date().toISOString(),
  };
  const result = await notes().insertOne(doc as NoteDoc & { _id?: unknown });
  return { ...doc, _id: String(result.insertedId) };
}

export async function listNotes(opts: {
  issueIid?: number;
  jobId?: string;
  limit?: number;
}): Promise<NoteDoc[]> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (opts.jobId) filter.jobId = opts.jobId;
  if (opts.issueIid !== undefined) filter.issueIid = opts.issueIid;
  const rows = await notes()
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(opts.limit ?? 100)
    .toArray();
  return rows.map((r) => ({
    ...r,
    _id: r._id ? String(r._id) : undefined,
  }));
}

export async function mongoPing(): Promise<boolean> {
  try {
    const database = await connectMongo();
    await database.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function addChatMessage(input: {
  jobId?: string;
  issueIid: number;
  role: "user" | "agent" | "system";
  kind: "clarify" | "qa" | "note";
  body: string;
}): Promise<ChatMessageDoc> {
  await connectMongo();
  const doc: ChatMessageDoc = {
    jobId: input.jobId,
    issueIid: input.issueIid,
    role: input.role,
    kind: input.kind,
    body: input.body.trim(),
    createdAt: new Date().toISOString(),
  };
  const result = await chat().insertOne(doc as ChatMessageDoc & { _id?: unknown });
  return { ...doc, _id: String(result.insertedId) };
}

export async function listChatMessages(opts: {
  jobId?: string;
  issueIid?: number;
  limit?: number;
}): Promise<ChatMessageDoc[]> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (opts.jobId) filter.jobId = opts.jobId;
  if (opts.issueIid !== undefined) filter.issueIid = opts.issueIid;
  const rows = await chat()
    .find(filter)
    .sort({ createdAt: 1 })
    .limit(opts.limit ?? 200)
    .toArray();
  return rows.map((r) => ({
    ...r,
    _id: r._id ? String(r._id) : undefined,
  }));
}
