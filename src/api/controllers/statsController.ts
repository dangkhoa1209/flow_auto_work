import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getDailyStats } from "../../modules/stats/index.js";

export const statsController = {
  daily: asyncHandler(async (req: Request, res: Response) => {
    const days = Number(req.query.days ?? "90");
    res.json(await getDailyStats(days));
  }),
};
