import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  listJobsForUi,
  startJobs,
  type StartJobsInput,
} from "../../services/jobService.js";
import type { JobStatus } from "../../types.js";

/**
 * Sample Express controllers — extract HTTP input, call services, write res.
 * No business logic here (queue / GitLab / Mongo stay in services).
 */
export const jobController = {
  /** GET /api/jobs?limit=&status= */
  list: asyncHandler(async (req: Request, res: Response) => {
    const status = req.query.status as JobStatus | undefined;
    const limit = Number(req.query.limit ?? "50");
    const data = await listJobsForUi({
      status,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    res.json(data);
  }),

  /** POST /api/jobs/start */
  start: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body || {}) as StartJobsInput;
    const result = await startJobs(body);
    res.json(result);
  }),
};
