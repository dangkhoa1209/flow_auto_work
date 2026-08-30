import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  getCompletionDefaults,
  listLabels,
  listMembers,
  listMilestones,
} from "../../modules/meta/index.js";

export const metaController = {
  completionDefaults: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(await getCompletionDefaults());
  }),
  members: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(await listMembers());
  }),
  labels: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(await listLabels());
  }),
  milestones: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(await listMilestones());
  }),
};
