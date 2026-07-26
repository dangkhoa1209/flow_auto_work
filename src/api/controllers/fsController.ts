import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  browseLocalPath,
  getWorkspaceContext,
} from "../../modules/fs/index.js";
import {
  headerProjectFromExpress,
  headerUserFromExpress,
} from "../middleware/workspaceAuth.js";

export const fsController = {
  browse: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await browseLocalPath(
        headerUserFromExpress(req),
        String(req.query.path || ""),
      ),
    );
  }),

  context: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await getWorkspaceContext(
        headerUserFromExpress(req),
        headerProjectFromExpress(req),
      ),
    );
  }),
};
