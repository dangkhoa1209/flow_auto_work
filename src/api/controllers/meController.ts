import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  clearMyCursorKey,
  getMe,
  getMyHandoffPrefs,
  listCursorModels,
  setMyQcRole,
  updateMyHandoffPrefs,
  updateMyPreferences,
  updateMySecrets,
  type UpdateSecretsBody,
} from "../../modules/me/index.js";
import type { HandoffPrefs } from "../../workspace/types.js";
import {
  headerProjectFromExpress,
  headerUserFromExpress,
} from "../middleware/workspaceAuth.js";

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

  getHandoffPrefs: asyncHandler(async (req: Request, res: Response) => {
    const q = typeof req.query.projectId === "string" ? req.query.projectId : "";
    const projectId = q || headerProjectFromExpress(req);
    res.json(await getMyHandoffPrefs(headerUserFromExpress(req), projectId));
  }),

  updateHandoffPrefs: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      projectId?: string;
      prefs?: HandoffPrefs;
    };
    const projectId =
      body.projectId?.trim() || headerProjectFromExpress(req) || undefined;
    res.json(
      await updateMyHandoffPrefs(headerUserFromExpress(req), {
        projectId,
        prefs: body.prefs,
      }),
    );
  }),

  cursorModels: asyncHandler(async (req: Request, res: Response) => {
    res.json(await listCursorModels(headerUserFromExpress(req)));
  }),

  clearCursorKey: asyncHandler(async (req: Request, res: Response) => {
    res.json(await clearMyCursorKey(headerUserFromExpress(req)));
  }),

  setQcRole: asyncHandler(async (req: Request, res: Response) => {
    const enabled = Boolean((req.body ?? {}).enabled);
    res.json(await setMyQcRole(headerUserFromExpress(req), enabled));
  }),
};
