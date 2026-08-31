import type { SoftDeleteFields } from "./base.js";
import { createModel, softUniquePartialFilter, withActive } from "./base.js";
import { connectMongo } from "./connection.js";
import { ChatModel } from "./chat.js";
import { NoteModel } from "./note.js";
import {
  jobIdForIssue,
  legacyJobIdForIssue,
  type JobRecord,
  type JobStatus,
} from "../types.js";

export type JobDoc = JobRecord & {
  _id: string;
  source?: string;
} & SoftDeleteFields;

export const JobModel = createModel<JobDoc>({
  collection: "jobs",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  indexes: [
    { keys: { "issue.issueIid": 1, updatedAt: -1 } },
    {
      keys: {
        workspaceProjectId: 1,
        "issue.projectId": 1,
        "issue.issueIid": 1,
      },
      options: {
        name: "ws_project_issue_soft_unique",
        unique: true,
        partialFilterExpression: {
          $and: [
            softUniquePartialFilter(),
            { workspaceProjectId: { $type: "string" } },
          ],
        },
      },
    },
    { keys: { status: 1, updatedAt: -1 } },
    { keys: { workspaceProjectId: 1, updatedAt: -1 } },
    { keys: { ownerUsername: 1, updatedAt: -1 } },
  ],
});

export async function upsertJobDoc(
  job: JobRecord,
  extra?: { source?: string },
): Promise<void> {
  await connectMongo();
  const col = await JobModel.col();
  // Never $set `source` together with $setOnInsert.source — Mongo conflict.
  const { source: _ignoredSource, ...jobFields } = job as JobRecord & {
    source?: string;
  };
  const setDoc: Record<string, unknown> = {
    ...jobFields,
    _id: job.id,
    deleted: false,
    deletedAt: null,
  };

  if (extra?.source) {
    setDoc.source = extra.source;
    await col.updateOne(
      { _id: job.id },
      {
        $set: setDoc,
        $setOnInsert: { deleted: false, deletedAt: null },
      },
      { upsert: true },
    );
    return;
  }

  await col.updateOne(
    { _id: job.id },
    {
      $set: setDoc,
      $setOnInsert: { source: "unknown", deleted: false, deletedAt: null },
    },
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
  return (await JobModel.col())
    .find(withActive(filter))
    .sort({ updatedAt: -1 })
    .limit(opts?.limit ?? 50)
    .toArray();
}

export async function getJobDoc(id: string): Promise<JobDoc | null> {
  await connectMongo();
  return (await JobModel.col()).findOne(withActive({ _id: id }));
}

export async function deleteJobDoc(id: string): Promise<boolean> {
  return JobModel.softDeleteById(id);
}

/** Soft-delete chat + notes for a job (before soft-deleting the job doc). */
export async function deleteJobSideDocs(
  jobId: string,
): Promise<{ chat: number; notes: number }> {
  const [chatN, notesN] = await Promise.all([
    ChatModel.softDeleteMany({ jobId }),
    NoteModel.softDeleteMany({ jobId }),
  ]);
  return { chat: chatN, notes: notesN };
}

/** Remap chat + notes from oldJobId → newJobId and update issueIid. */
export async function rekeyJobSideDocs(opts: {
  fromJobId: string;
  toJobId: string;
  issueIid: number;
}): Promise<{ chat: number; notes: number }> {
  await connectMongo();
  const chatRes = await (await ChatModel.col()).updateMany(
    { jobId: opts.fromJobId },
    { $set: { jobId: opts.toJobId, issueIid: opts.issueIid } },
  );
  const notesRes = await (await NoteModel.col()).updateMany(
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
  const col = await JobModel.col();
  const ws = workspaceProjectId?.trim();
  if (ws) {
    const scoped = await col.findOne(
      withActive({ _id: jobIdForIssue(projectId, issueIid, ws) }),
    );
    if (scoped) return scoped;

    const legacy = await col.findOne(
      withActive({ _id: legacyJobIdForIssue(projectId, issueIid) }),
    );
    if (legacy) {
      const legacyWs = (legacy.workspaceProjectId || "").trim();
      if (!legacyWs || legacyWs === ws) return legacy;
    }

    return col.findOne(
      withActive({
        workspaceProjectId: ws,
        "issue.projectId": projectId,
        "issue.issueIid": issueIid,
      }),
      { sort: { updatedAt: -1 } },
    );
  }

  const stable = await col.findOne(
    withActive({ _id: legacyJobIdForIssue(projectId, issueIid) }),
  );
  if (stable) return stable;
  return col.findOne(
    withActive({
      "issue.projectId": projectId,
      "issue.issueIid": issueIid,
    }),
    { sort: { updatedAt: -1 } },
  );
}
