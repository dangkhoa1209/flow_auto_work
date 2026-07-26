import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getStatusPayload } from "../../modules/status/index.js";

export const statusController = {
  get: asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getStatusPayload());
  }),
};
