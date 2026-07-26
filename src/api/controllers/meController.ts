import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  clearMyCursorKey,
  getMe,
  listCursorModels,
  updateMyPreferences,
  updateMySecrets,
  type UpdateSecretsBody,
} from "../../modules/me/index.js";
import { headerUserFromExpress } from "../middleware/workspaceAuth.js";

export const meController = {
  get: asyncHandler(async (req: Request, res: Response) => {
    res.json(await getMe(headerUserFromExpress(req)));
  }),

  updateSecrets: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as UpdateSecretsBody;
    res.json(await updateMySecrets(headerUserFromExpress(req), body));
  }),

  updatePreferences: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { cursorModel?: string };
    res.json(await updateMyPreferences(headerUserFromExpress(req), body));
  }),

  cursorModels: asyncHandler(async (req: Request, res: Response) => {
    res.json(await listCursorModels(headerUserFromExpress(req)));
  }),

  clearCursorKey: asyncHandler(async (req: Request, res: Response) => {
    res.json(await clearMyCursorKey(headerUserFromExpress(req)));
  }),
};
