import { ObjectId, type WithId } from "mongodb";
import { createModel, type SoftDeleteFields } from "./base.js";
import { connectMongo } from "./connection.js";

export type NoteDoc = {
  _id?: ObjectId | string;
  jobId?: string;
  issueIid: number;
  projectPath: string;
  body: string;
  createdAt: string;
} & SoftDeleteFields;

export type NoteRow = Omit<NoteDoc, "_id"> & { _id: string };

export const NoteModel = createModel<NoteDoc>({
  collection: "notes",
  softDelete: true,
  defaultSort: { createdAt: -1 },
  parseId: (id) => {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Invalid note id: ${id}`);
    }
    return new ObjectId(id);
  },
  indexes: [
    { keys: { issueIid: 1, createdAt: -1 } },
    { keys: { jobId: 1, createdAt: -1 } },
  ],
});

export function toNoteRow(doc: WithId<NoteDoc> | NoteDoc): NoteRow {
  return {
    ...doc,
    _id: doc._id ? String(doc._id) : "",
  };
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
  const result = await (await NoteModel.col()).insertOne(
    doc as NoteDoc & { _id?: unknown },
  );
  return { ...doc, _id: String(result.insertedId) };
}

export async function listNotes(opts: {
  issueIid?: number;
  jobId?: string;
  limit?: number;
}): Promise<NoteDoc[]> {
  const filter: Record<string, unknown> = {};
  if (opts.jobId) filter.jobId = opts.jobId;
  if (opts.issueIid !== undefined) filter.issueIid = opts.issueIid;
  const rows = await NoteModel.findMany({
    filter,
    sort: { createdAt: -1 },
    limit: opts.limit ?? 100,
  });
  return rows.map((r) => ({
    ...r,
    _id: r._id ? String(r._id) : undefined,
  }));
}
