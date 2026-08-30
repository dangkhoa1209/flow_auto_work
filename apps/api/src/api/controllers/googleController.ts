import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  continueJobAfterGoogleAuth,
  detectJobGoogleSheets,
  getGoogleAuthUrlForJob,
  getJobGoogleStatus,
  googleOAuthCallbackHtml,
  handleGoogleOAuthCallback,
  revokeJobGoogleAuth,
  setJobGoogleSheetsInclude,
} from "../../modules/google/index.js";

function jobId(req: Request): string {
  return String(req.params.id || req.query.jobId || "").trim();
}

export const googleController = {
  /** GET /api/google/auth-url?jobId= */
  authUrl: asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.query.jobId || "").trim();
    if (!id) {
      res.formatter.badRequest("jobId query required");
      return;
    }
    res.formatter.ok(await getGoogleAuthUrlForJob(id));
  }),

  /** GET /api/google/callback — public; HTML closes popup */
  callback: asyncHandler(async (req: Request, res: Response) => {
    const result = await handleGoogleOAuthCallback({
      code: typeof req.query.code === "string" ? req.query.code : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      error: typeof req.query.error === "string" ? req.query.error : undefined,
    });
    res
      .status(result.ok ? 200 : 400)
      .type("html")
      .send(googleOAuthCallbackHtml(result));
  }),

  /** GET /api/jobs/:id/google/status */
  status: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await getJobGoogleStatus(jobId(req)));
  }),

  /** GET /api/jobs/:id/google/detect */
  detect: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await detectJobGoogleSheets(jobId(req)));
  }),

  /** PUT /api/jobs/:id/google/include */
  include: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { spreadsheetIds?: string[] };
    const ids = Array.isArray(body.spreadsheetIds) ? body.spreadsheetIds : [];
    res.formatter.ok(await setJobGoogleSheetsInclude(jobId(req), ids));
  }),

  /** POST /api/jobs/:id/google/revoke */
  revoke: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await revokeJobGoogleAuth(jobId(req)));
  }),

  /** POST /api/jobs/:id/google/continue */
  continueRun: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await continueJobAfterGoogleAuth(jobId(req)));
  }),
};
