import type { Sort } from "mongodb";
import { NoteModel, toNoteRow, type NoteRow } from "../../models/note.js";
import { resolveGitlabProjectPath } from "../../workspace/creds.js";
import { AppError } from "../../utils/AppError.js";

export type ListNotesOpts = {
  issueIid?: number;
  jobId?: string;
  sort?: Sort;
  skip?: number;
  limit?: number;
};

export async function listNotesForUi(opts: ListNotesOpts): Promise<{
  notes: NoteRow[];
  count: number;
}> {
  const filter: Record<string, unknown> = {};
  if (opts.jobId) filter.jobId = opts.jobId;
  if (opts.issueIid !== undefined) filter.issueIid = opts.issueIid;
  const [rows, count] = await Promise.all([
    NoteModel.findMany({
      filter,
      sort: opts.sort ?? { createdAt: -1 },
      skip: opts.skip,
      limit: opts.limit ?? 100,
    }),
    NoteModel.count({ filter }),
  ]);
  return { notes: rows.map(toNoteRow), count };
}

export async function createNote(body: {
  issueIid?: number;
  jobId?: string;
  body?: string;
}): Promise<{ note: NoteRow }> {
  if (!body.body?.trim() || body.issueIid === undefined) {
    throw new AppError("issueIid and body required", 400);
  }
  const doc = await NoteModel.insert({
    jobId: body.jobId,
    issueIid: Number(body.issueIid),
    projectPath: resolveGitlabProjectPath(),
    body: body.body.trim(),
    createdAt: new Date().toISOString(),
  });
  return { note: toNoteRow(doc) };
}

export async function deleteNote(opts: {
  noteId: string;
}): Promise<{ ok: true }> {
  const id = opts.noteId.trim();
  if (!id) throw new AppError("note id required", 400);
  let ok = false;
  try {
    ok = await NoteModel.softDeleteById(id);
  } catch {
    throw new AppError("Invalid note id", 400);
  }
  if (!ok) throw new AppError("Note not found", 404);
  return { ok: true };
}
