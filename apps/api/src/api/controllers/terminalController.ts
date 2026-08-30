import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { terminalStatusPayload } from "../../plugins/terminal/gate.js";

export const terminalController = {
  /** GET /api/terminal/status — whether PTY UI may connect */
  status: asyncHandler(async (req: Request, res: Response) => {
    const remote =
      req.socket?.remoteAddress ||
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    res.formatter.ok(terminalStatusPayload(remote));
  }),
};
