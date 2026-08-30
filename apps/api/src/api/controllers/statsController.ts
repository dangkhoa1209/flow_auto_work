import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getDailyStats } from "../../modules/stats/index.js";
import { analyzeDevPerformance } from "../../modules/stats/analyze.js";

function flag(v: unknown): boolean {
  return v === "1" || v === "true" || v === true;
}

function statsQueryFromReq(req: Request) {
  return {
    days: Number(req.query.days ?? req.body?.days ?? "90"),
    from:
      typeof req.query.from === "string"
        ? req.query.from
        : typeof req.body?.from === "string"
          ? req.body.from
          : undefined,
    to:
      typeof req.query.to === "string"
        ? req.query.to
        : typeof req.body?.to === "string"
          ? req.body.to
          : undefined,
    status:
      typeof req.query.status === "string"
        ? req.query.status
        : typeof req.body?.status === "string"
          ? req.body.status
          : undefined,
    workspaceProjectId:
      typeof req.query.workspaceProjectId === "string"
        ? req.query.workspaceProjectId
        : undefined,
    allProjects: flag(req.query.allProjects ?? req.body?.allProjects),
    q:
      typeof req.query.q === "string"
        ? req.query.q
        : typeof req.body?.q === "string"
          ? req.body.q
          : undefined,
  };
}

export const statsController = {
  daily: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await getDailyStats(statsQueryFromReq(req)));
  }),

  analyze: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await analyzeDevPerformance(statsQueryFromReq(req), {
        force: flag(req.query.force ?? req.body?.force),
      }),
    );
  }),
};
