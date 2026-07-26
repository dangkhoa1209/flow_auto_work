import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  getCompletionDefaults,
  listLabels,
  listMembers,
} from "../../modules/meta/index.js";

export const metaController = {
  completionDefaults: asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getCompletionDefaults());
  }),
  members: asyncHandler(async (_req: Request, res: Response) => {
    res.json(await listMembers());
  }),
  labels: asyncHandler(async (_req: Request, res: Response) => {
    res.json(await listLabels());
  }),
};
