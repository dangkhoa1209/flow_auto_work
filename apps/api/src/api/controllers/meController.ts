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
    res.formatter.ok(await getMe(headerUserFromExpress(req)));
  }),

  updateSecrets: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as UpdateSecretsBody;
    res.formatter.ok(await updateMySecrets(headerUserFromExpress(req), body));
  }),

  updatePreferences: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { cursorModel?: string };
    res.formatter.ok(await updateMyPreferences(headerUserFromExpress(req), body));
  }),

  getHandoffPrefs: asyncHandler(async (req: Request, res: Response) => {
    const q = typeof req.query.projectId === "string" ? req.query.projectId : "";
    const projectId = q || headerProjectFromExpress(req);
    res.formatter.ok(await getMyHandoffPrefs(headerUserFromExpress(req), projectId));
  }),

  updateHandoffPrefs: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      projectId?: string;
      prefs?: HandoffPrefs;
    };
    const projectId =
      body.projectId?.trim() || headerProjectFromExpress(req) || undefined;
    res.formatter.ok(
      await updateMyHandoffPrefs(headerUserFromExpress(req), {
        projectId,
        prefs: body.prefs,
      }),
    );
  }),

  cursorModels: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await listCursorModels(headerUserFromExpress(req)));
  }),

  clearCursorKey: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await clearMyCursorKey(headerUserFromExpress(req)));
  }),

  setQcRole: asyncHandler(async (req: Request, res: Response) => {
    const enabled = Boolean((req.body ?? {}).enabled);
    res.formatter.ok(await setMyQcRole(headerUserFromExpress(req), enabled));
  }),
};
