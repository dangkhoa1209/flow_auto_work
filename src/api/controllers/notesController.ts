import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { createNote, listNotesForUi } from "../../modules/notes/index.js";

export const notesController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const issueIid = req.query.issueIid
      ? Number(req.query.issueIid)
      : undefined;
    const jobId = req.query.jobId ? String(req.query.jobId) : undefined;
    res.json(await listNotesForUi({ issueIid, jobId }));
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    res.json(await createNote(req.body || {}));
  }),
};
