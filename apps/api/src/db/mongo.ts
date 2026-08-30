import { MongoClient, type Collection, type Db } from "mongodb";
import { buildMongoUri, getConfig } from "../config.js";
import { logger } from "../logger.js";
import { publishRealtime } from "../plugins/realtime/hub.js";
import {
  jobIdForIssue,
  legacyJobIdForIssue,
  type JobRecord,
  type JobStatus,
} from "../types.js";

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
  // Legacy unique (gitlab project + iid only) blocked one job per Flow project.
  try {
    await db.collection("jobs").dropIndex("issue.projectId_1_issue.issueIid_1");
  } catch {
    /* index may not exist */
  }
  try {
    await db.collection("jobs").createIndex(
      {
        workspaceProjectId: 1,
        "issue.projectId": 1,
        "issue.issueIid": 1,
      },
      {
        unique: true,
        name: "ws_project_issue_unique",
        partialFilterExpression: {
          workspaceProjectId: { $type: "string" },
        },
      },
    );
  } catch (err) {
    logger.warn(
      "Unique jobs index (workspace+projectId+issueIid) skipped — dedupe if needed",
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
  await db.collection("stats_analysis_cache").createIndex({ analyzedAt: -1 });
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("MongoDB not connected");
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
}): Promise<JobDoc[]> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (opts?.status) filter.status = opts.status;
  if (opts?.workspaceProjectId) {
    filter.workspaceProjectId = opts.workspaceProjectId;
  }
  if (opts?.ownerUsername) filter.ownerUsername = opts.ownerUsername;
  return jobs()
    .find(filter)
    .sort({ updatedAt: -1 })
    .limit(opts?.limit ?? 50)
    .toArray();
}

const STATS_TZ = "Asia/Ho_Chi_Minh";
const STATS_HARD_CAP = 10_000;

const attributedAtExpr = {
  $let: {
    vars: {
      raw: {
        $ifNull: [
          "$completedAt",
          { $ifNull: ["$handedOffAt", { $ifNull: ["$updatedAt", "$createdAt"] }] },
        ],
      },
    },
    in: {
      $switch: {
        branches: [
          {
            case: { $eq: [{ $type: "$$raw" }, "date"] },
            then: "$$raw",
          },
        ],
        default: {
          $dateFromString: {
            dateString: "$$raw",
            onError: null,
            onNull: null,
          },
        },
      },
    },
  },
};

function toDateExpr(field: string) {
  return {
    $cond: [
      { $eq: [{ $type: `$${field}` }, "date"] },
      `$${field}`,
      {
        $dateFromString: {
          dateString: `$${field}`,
          onError: null,
          onNull: null,
        },
      },
    ],
  };
}

export type JobStatsAggQuery = {
  workspaceProjectId?: string;
  ownerUsername?: string;
  statuses?: string[];
  rangeStart: Date;
  rangeEnd: Date;
  q?: string;
  hardCap?: number;
};

export type JobStatsAggRow = {
  dayKey: string;
  jobId: string;
  status: string;
  issueIid: number;
  title: string;
  url: string;
  at: string;
  summary?: string;
  error?: string;
  workspaceProjectId?: string;
  ownerUsername?: string;
  tokensTotal: number;
  tokensInput: number;
  tokensOutput: number;
  durationMs: number | null;
};

export type JobStatsAggResult = {
  totalInRange: number;
  truncated: boolean;
  rows: JobStatsAggRow[];
  owners: string[];
  projects: string[];
};

function statsMatchFilter(opts: JobStatsAggQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (opts.workspaceProjectId) {
    filter.workspaceProjectId = opts.workspaceProjectId;
  }
  if (opts.ownerUsername) filter.ownerUsername = opts.ownerUsername;
  if (opts.statuses?.length) filter.status = { $in: opts.statuses };
  const q = opts.q?.trim();
  if (q) {
    const iid = Number(q.replace(/^#/, ""));
    const or: Record<string, unknown>[] = [
      { "issue.title": { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
    ];
    if (Number.isFinite(iid) && iid > 0) {
      or.push({ "issue.issueIid": iid });
    }
    filter.$or = or;
  }
  return filter;
}

/**
 * Load attributed jobs in a date window via aggregation (no silent 500 cap).
 * Caps at 10k most-recent attributed rows and reports truncation.
 */
export async function aggregateJobsForStats(
  opts: JobStatsAggQuery,
): Promise<JobStatsAggResult> {
  await connectMongo();
  const cap = opts.hardCap ?? STATS_HARD_CAP;
  const match = statsMatchFilter(opts);

  const countPipe = [
    { $match: match },
    { $addFields: { attributedAt: attributedAtExpr } },
    {
      $match: {
        attributedAt: { $ne: null, $gte: opts.rangeStart, $lte: opts.rangeEnd },
      },
    },
    { $count: "n" },
  ];

  const dataPipe = [
    { $match: match },
    { $addFields: { attributedAt: attributedAtExpr } },
    {
      $match: {
        attributedAt: { $ne: null, $gte: opts.rangeStart, $lte: opts.rangeEnd },
      },
    },
    { $sort: { attributedAt: -1 } },
    { $limit: cap },
    {
      $addFields: {
        dayKey: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$attributedAt",
            timezone: STATS_TZ,
          },
        },
        createdAtDate: toDateExpr("createdAt"),
        endAtDate: {
          $ifNull: [toDateExpr("completedAt"), toDateExpr("updatedAt")],
        },
      },
    },
    {
      $addFields: {
        durationMs: {
          $cond: [
            {
              $and: [
                { $ne: ["$createdAtDate", null] },
                { $ne: ["$endAtDate", null] },
              ],
            },
            { $subtract: ["$endAtDate", "$createdAtDate"] },
            null,
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        dayKey: 1,
        jobId: { $ifNull: ["$id", "$_id"] },
        status: 1,
        issueIid: { $ifNull: ["$issue.issueIid", 0] },
        title: { $ifNull: ["$issue.title", ""] },
        url: { $ifNull: ["$issue.url", ""] },
        at: {
          $dateToString: { date: "$attributedAt", format: "%Y-%m-%dT%H:%M:%S.%LZ" },
        },
        summary: 1,
        error: { $substrCP: [{ $ifNull: ["$error", ""] }, 0, 240] },
        workspaceProjectId: 1,
        ownerUsername: 1,
        tokensTotal: { $ifNull: ["$tokenUsage.totalTokens", 0] },
        tokensInput: { $ifNull: ["$tokenUsage.inputTokens", 0] },
        tokensOutput: { $ifNull: ["$tokenUsage.outputTokens", 0] },
        durationMs: 1,
      },
    },
  ];

  const [countDocs, rows] = await Promise.all([
    jobs().aggregate<{ n: number }>(countPipe).toArray(),
    jobs().aggregate<JobStatsAggRow>(dataPipe, { allowDiskUse: true }).toArray(),
  ]);

  const totalInRange = countDocs[0]?.n ?? 0;
  const owners = [
    ...new Set(rows.map((r) => r.ownerUsername).filter((x): x is string => !!x)),
  ].sort();
  const projects = [
    ...new Set(
      rows.map((r) => r.workspaceProjectId).filter((x): x is string => !!x),
    ),
  ].sort();

  return {
    totalInRange,
    truncated: totalInRange > rows.length,
    rows,
    owners,
    projects,
  };
}

export type DevAnalysisJobRow = JobStatsAggRow & {
  labels: string[];
  runCount: number;
  createdAt: string;
  completedAt?: string;
};

/** Same window/filter as stats, with labels + runCount for dev evaluation. */
export async function aggregateJobsForDevAnalysis(
  opts: JobStatsAggQuery,
): Promise<Omit<JobStatsAggResult, "rows"> & { rows: DevAnalysisJobRow[] }> {
  await connectMongo();
  const cap = opts.hardCap ?? STATS_HARD_CAP;
  const match = statsMatchFilter(opts);

  const countPipe = [
    { $match: match },
    { $addFields: { attributedAt: attributedAtExpr } },
    {
      $match: {
        attributedAt: { $ne: null, $gte: opts.rangeStart, $lte: opts.rangeEnd },
      },
    },
    { $count: "n" },
  ];

  const dataPipe = [
    { $match: match },
    { $addFields: { attributedAt: attributedAtExpr } },
    {
      $match: {
        attributedAt: { $ne: null, $gte: opts.rangeStart, $lte: opts.rangeEnd },
      },
    },
    { $sort: { attributedAt: -1 } },
    { $limit: cap },
    {
      $addFields: {
        dayKey: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$attributedAt",
            timezone: STATS_TZ,
          },
        },
        createdAtDate: toDateExpr("createdAt"),
        endAtDate: {
          $ifNull: [toDateExpr("completedAt"), toDateExpr("updatedAt")],
        },
      },
    },
    {
      $addFields: {
        durationMs: {
          $cond: [
            {
              $and: [
                { $ne: ["$createdAtDate", null] },
                { $ne: ["$endAtDate", null] },
              ],
            },
            { $subtract: ["$endAtDate", "$createdAtDate"] },
            null,
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        dayKey: 1,
        jobId: { $ifNull: ["$id", "$_id"] },
        status: 1,
        issueIid: { $ifNull: ["$issue.issueIid", 0] },
        title: { $ifNull: ["$issue.title", ""] },
        url: { $ifNull: ["$issue.url", ""] },
        at: {
          $dateToString: { date: "$attributedAt", format: "%Y-%m-%dT%H:%M:%S.%LZ" },
        },
        summary: 1,
        error: { $substrCP: [{ $ifNull: ["$error", ""] }, 0, 240] },
        workspaceProjectId: 1,
        ownerUsername: 1,
        tokensTotal: { $ifNull: ["$tokenUsage.totalTokens", 0] },
        tokensInput: { $ifNull: ["$tokenUsage.inputTokens", 0] },
        tokensOutput: { $ifNull: ["$tokenUsage.outputTokens", 0] },
        durationMs: 1,
        labels: { $ifNull: ["$issue.labels", []] },
        runCount: { $ifNull: ["$runCount", 0] },
        createdAt: 1,
        completedAt: 1,
      },
    },
  ];

  const [countDocs, rows] = await Promise.all([
    jobs().aggregate<{ n: number }>(countPipe).toArray(),
    jobs()
      .aggregate<DevAnalysisJobRow>(dataPipe, { allowDiskUse: true })
      .toArray(),
  ]);

  const totalInRange = countDocs[0]?.n ?? 0;
  const owners = [
    ...new Set(rows.map((r) => r.ownerUsername).filter((x): x is string => !!x)),
  ].sort();
  const projects = [
    ...new Set(
      rows.map((r) => r.workspaceProjectId).filter((x): x is string => !!x),
    ),
  ].sort();

  return {
    totalInRange,
    truncated: totalInRange > rows.length,
    rows,
    owners,
    projects,
  };
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

/**
 * One GitLab issue → one job **per Flow workspace project**.
 * Prefers scoped id, then legacy id when it already belongs to this workspace.
 */
export async function getJobDocByIssue(
  projectId: number,
  issueIid: number,
  workspaceProjectId?: string,
): Promise<JobDoc | null> {
  await connectMongo();
  const ws = workspaceProjectId?.trim();
  if (ws) {
    const scoped = await jobs().findOne({
      _id: jobIdForIssue(projectId, issueIid, ws),
    });
    if (scoped) return scoped;

    const legacy = await jobs().findOne({
      _id: legacyJobIdForIssue(projectId, issueIid),
    });
    if (legacy) {
      const legacyWs = (legacy.workspaceProjectId || "").trim();
      if (!legacyWs || legacyWs === ws) return legacy;
    }

    return jobs().findOne(
      {
        workspaceProjectId: ws,
        "issue.projectId": projectId,
        "issue.issueIid": issueIid,
      },
      { sort: { updatedAt: -1 } },
    );
  }

  const stable = await jobs().findOne({
    _id: legacyJobIdForIssue(projectId, issueIid),
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
