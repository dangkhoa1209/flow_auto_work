import { MongoClient, type Collection, type Db } from "mongodb";
import { buildMongoUri, getConfig } from "../config.js";
import { logger } from "../logger.js";
import { publishRealtime } from "../plugins/realtime/hub.js";
import { jobIdForIssue, type JobRecord, type JobStatus } from "../types.js";

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
  const cfg = getConfig();
  const uri = buildMongoUri(cfg);
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(cfg.DB_DATABASE);
  await db.collection("jobs").createIndex({ "issue.issueIid": 1, updatedAt: -1 });
  try {
    await db.collection("jobs").createIndex(
      { "issue.projectId": 1, "issue.issueIid": 1 },
      { unique: true },
    );
  } catch (err) {
    logger.warn(
      "Unique jobs index (projectId+issueIid) skipped — dedupe legacy jobs if needed",
      { err: String(err) },
    );
  }
  await db.collection("jobs").createIndex({ status: 1, updatedAt: -1 });
  await db
    .collection("jobs")
    .createIndex({ workspaceProjectId: 1, updatedAt: -1 });
  await db.collection("jobs").createIndex({ ownerUsername: 1, updatedAt: -1 });
  await db.collection("notes").createIndex({ issueIid: 1, createdAt: -1 });
  await db.collection("notes").createIndex({ jobId: 1, createdAt: -1 });
  await db.collection("chat").createIndex({ jobId: 1, createdAt: 1 });
  await db.collection("chat").createIndex({ issueIid: 1, createdAt: 1 });
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
  workspaceProjectId?: string;
  ownerUsername?: string;
  /** When true (default for coding UI), hide QA triage jobs */
  excludeQa?: boolean;
  /** When set, only return jobs of this kind */
  kind?: "issue" | "adhoc" | "qa";
}): Promise<JobDoc[]> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (opts?.status) filter.status = opts.status;
  if (opts?.workspaceProjectId) {
    filter.workspaceProjectId = opts.workspaceProjectId;
  }
  if (opts?.ownerUsername) filter.ownerUsername = opts.ownerUsername;
  if (opts?.kind) {
    filter.kind = opts.kind;
  } else if (opts?.excludeQa !== false) {
    // $ne also matches missing kind — coding jobs stay visible
    filter.kind = { $ne: "qa" };
  }
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

export async function deleteJobDoc(id: string): Promise<boolean> {
  await connectMongo();
  const res = await jobs().deleteOne({ _id: id });
  return res.deletedCount > 0;
}

/** Remove chat + notes for a job (before deleting the job doc). */
export async function deleteJobSideDocs(
  jobId: string,
): Promise<{ chat: number; notes: number }> {
  await connectMongo();
  const [chatRes, notesRes] = await Promise.all([
    chat().deleteMany({ jobId }),
    notes().deleteMany({ jobId }),
  ]);
  return {
    chat: chatRes.deletedCount,
    notes: notesRes.deletedCount,
  };
}

/** Remap chat + notes from oldJobId → newJobId and update issueIid. */
export async function rekeyJobSideDocs(opts: {
  fromJobId: string;
  toJobId: string;
  issueIid: number;
}): Promise<{ chat: number; notes: number }> {
  await connectMongo();
  const chatRes = await chat().updateMany(
    { jobId: opts.fromJobId },
    { $set: { jobId: opts.toJobId, issueIid: opts.issueIid } },
  );
  const notesRes = await notes().updateMany(
    { jobId: opts.fromJobId },
    { $set: { jobId: opts.toJobId, issueIid: opts.issueIid } },
  );
  return {
    chat: chatRes.modifiedCount,
    notes: notesRes.modifiedCount,
  };
}

/** One issue → one job: prefer stable id, else latest legacy doc for that issue */
export async function getJobDocByIssue(
  projectId: number,
  issueIid: number,
): Promise<JobDoc | null> {
  await connectMongo();
  const stable = await jobs().findOne({
    _id: jobIdForIssue(projectId, issueIid),
  });
  if (stable) return stable;
  return jobs().findOne(
    { "issue.projectId": projectId, "issue.issueIid": issueIid },
    { sort: { updatedAt: -1 } },
  );
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
  const saved = { ...doc, _id: String(result.insertedId) };
  // Realtime push — UI appends without polling /chat
  if (saved.jobId) {
    publishRealtime({
      type: "chat",
      jobId: saved.jobId,
      message: {
        id: saved._id,
        jobId: saved.jobId,
        issueIid: saved.issueIid,
        role: saved.role,
        kind: saved.kind,
        body: saved.body,
        createdAt: saved.createdAt,
      },
    });
  }
  return saved;
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
