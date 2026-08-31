import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  activateMyCursorPat,
  addMyCursorPat,
  changeMyPassword,
  clearMyCursorKey,
  getMe,
  getMyCursorPats,
  getMyHandoffPrefs,
  listCursorModels,
  patchMyCursorPat,
  removeMyCursorPat,
  setMyQcRole,
  updateMyHandoffPrefs,
  updateMyIntegrations,
  updateMyPreferences,
  updateMySecrets,
  type UpdateSecretsBody,
} from "../../modules/me/index.js";
import * as googleMod from "../../modules/google/index.js";
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
    const patId =
      typeof req.query.patId === "string" ? req.query.patId : undefined;
    res.formatter.ok(
      await listCursorModels(headerUserFromExpress(req), patId),
    );
  }),

  cursorPats: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await getMyCursorPats(headerUserFromExpress(req)));
  }),

  createCursorPat: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { label?: string; apiKey?: string };
    res.formatter.ok(
      await addMyCursorPat(headerUserFromExpress(req), body),
    );
  }),

  updateCursorPat: asyncHandler(async (req: Request, res: Response) => {
    const patId = String(req.params.patId ?? "").trim();
    const body = (req.body ?? {}) as { label?: string; apiKey?: string };
    res.formatter.ok(
      await patchMyCursorPat(headerUserFromExpress(req), patId, body),
    );
  }),

  activateCursorPat: asyncHandler(async (req: Request, res: Response) => {
    const patId = String(req.params.patId ?? "").trim();
    res.formatter.ok(
      await activateMyCursorPat(headerUserFromExpress(req), patId),
    );
  }),

  deleteCursorPat: asyncHandler(async (req: Request, res: Response) => {
    const patId = String(req.params.patId ?? "").trim();
    res.formatter.ok(
      await removeMyCursorPat(headerUserFromExpress(req), patId),
    );
  }),

  clearCursorKey: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await clearMyCursorKey(headerUserFromExpress(req)));
  }),

  setQcRole: asyncHandler(async (req: Request, res: Response) => {
    const enabled = Boolean((req.body ?? {}).enabled);
    res.formatter.ok(await setMyQcRole(headerUserFromExpress(req), enabled));
  }),

  googleStatus: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await googleMod.getBaGoogleStatus(headerUserFromExpress(req)),
    );
  }),

  googleAuthUrl: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await googleMod.getBaGoogleAuthUrl(headerUserFromExpress(req)),
    );
  }),

  googleRevoke: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await googleMod.revokeBaGoogleAuth(headerUserFromExpress(req)),
    );
  }),

  updateIntegrations: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { figmaToken?: string | null };
    res.formatter.ok(
      await updateMyIntegrations(headerUserFromExpress(req), body),
    );
  }),

  changePassword: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
    };
    res.formatter.ok(
      await changeMyPassword(headerUserFromExpress(req), body),
    );
  }),
};
