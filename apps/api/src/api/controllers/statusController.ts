import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getStatusPayload } from "../../modules/status/index.js";
import {
  headerProjectFromExpress,
  headerUserFromExpress,
} from "../middleware/workspaceAuth.js";

export const statusController = {
  get: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await getStatusPayload({
        ownerUsername: headerUserFromExpress(req),
        workspaceProjectId: headerProjectFromExpress(req),
      }),
    );
  }),
};
