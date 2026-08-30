import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  getTaskDetail,
  listTasks,
  updateTasks,
} from "../../modules/task/index.js";

export const taskController = {
  list: asyncHandler(async (_req: Request, res: Response) => {
    res.json(await listTasks());
  }),

  one: asyncHandler(async (req: Request, res: Response) => {
    const iid = Number(req.params.iid);
    res.json(await getTaskDetail(iid));
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    res.json(await updateTasks(req.body || {}));
  }),
};
