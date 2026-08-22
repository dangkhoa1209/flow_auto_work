import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  continueJobAfterFigmaAuth,
  detectJobFigma,
  getJobFigmaStatus,
  setJobFigmaInclude,
} from "../../modules/figma/index.js";

function jobId(req: Request): string {
  return String(req.params.id || req.query.jobId || "").trim();
}

export const figmaController = {
  /** GET /api/jobs/:id/figma/status */
  status: asyncHandler(async (req: Request, res: Response) => {
    res.json(await getJobFigmaStatus(jobId(req)));
  }),

  /** GET /api/jobs/:id/figma/detect */
  detect: asyncHandler(async (req: Request, res: Response) => {
    res.json(await detectJobFigma(jobId(req)));
  }),

  /** PUT /api/jobs/:id/figma/include */
  include: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { includeKeys?: string[] };
    const keys = Array.isArray(body.includeKeys) ? body.includeKeys : [];
    res.json(await setJobFigmaInclude(jobId(req), keys));
  }),

  /** POST /api/jobs/:id/figma/continue */
  continueRun: asyncHandler(async (req: Request, res: Response) => {
    res.json(await continueJobAfterFigmaAuth(jobId(req)));
  }),
};
