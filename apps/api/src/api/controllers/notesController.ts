import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { listQuery } from "../../plugins/fetch/index.js";
import {
  createNote,
  deleteNote,
  listNotesForUi,
} from "../../modules/notes/index.js";

export const notesController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const issueIid = req.query.issueIid
      ? Number(req.query.issueIid)
      : undefined;
    const jobId = req.query.jobId ? String(req.query.jobId) : undefined;
    const q = listQuery(req, { sort: { createdAt: -1 }, limit: 100 });
    const { notes, count } = await listNotesForUi({
      issueIid,
      jobId,
      sort: q.sort,
      skip: q.skip,
      limit: q.limit,
    });
    res.formatter.ok(
      { notes, count },
      { sort: q.sort, skip: q.skip, limit: q.limit },
    );
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.created(await createNote(req.body || {}));
  }),

  delete: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await deleteNote({ noteId: String(req.params.noteId || "") }),
    );
  }),
};
