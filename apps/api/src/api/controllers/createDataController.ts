import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { requireRoleContext } from "../middleware/roleAuth.js";
import {
  createDataCreateBatch,
  createDataExecuteBatch,
  createDataGetBatch,
  createDataListBatches,
  createDataPlan,
  createDataRollbackBatch,
  parseEnvironment,
  stopCreateDataPlanner,
} from "../../modules/createData/index.js";

function userId(): string {
  return requireRoleContext().username.toLowerCase();
}

function requireProjectId(raw: unknown): string {
  const projectId = String(raw || "").trim();
  if (!projectId) {
    throw new AppError("baProjectId required", 400, "create_data_project_required");
  }
  return projectId;
}

export const createDataController = {
  plan: asyncHandler(async (req: Request, res: Response) => {
    const prompt = String(req.body?.prompt || "").trim();
    const baProjectId = requireProjectId(
      req.body?.baProjectId || req.body?.projectId,
    );
    const plan = await createDataPlan({
      userId: userId(),
      prompt,
      baProjectId,
      environment: req.body?.environment,
      heuristicOnly: Boolean(req.body?.heuristicOnly),
    });
    res.formatter.ok({ plan });
  }),

  stopPlan: asyncHandler(async (req: Request, res: Response) => {
    const baProjectId = requireProjectId(
      req.body?.baProjectId || req.body?.projectId,
    );
    const cancelled = await stopCreateDataPlanner(userId(), baProjectId);
    res.formatter.ok({ ok: true, cancelled });
  }),

  listBatches: asyncHandler(async (req: Request, res: Response) => {
    const baProjectId = requireProjectId(
      req.query.baProjectId || req.query.projectId,
    );
    const limit = Number(req.query.limit || 40);
    const batches = await createDataListBatches({
      userId: userId(),
      baProjectId,
      limit: Number.isFinite(limit) ? limit : 40,
    });
    res.formatter.ok({ batches });
  }),

  createBatch: asyncHandler(async (req: Request, res: Response) => {
    const baProjectId = requireProjectId(
      req.body?.baProjectId || req.body?.projectId,
    );
    const batch = await createDataCreateBatch({
      userId: userId(),
      baProjectId,
      prompt: String(req.body?.prompt || ""),
      environment: parseEnvironment(req.body?.environment),
      apiBaseUrl: String(req.body?.apiBaseUrl || ""),
      steps: req.body?.steps,
      questions: req.body?.questions,
    });
    res.formatter.ok({ batch });
  }),

  getBatch: asyncHandler(async (req: Request, res: Response) => {
    const batch = await createDataGetBatch({
      userId: userId(),
      id: String(req.params.id || ""),
    });
    res.formatter.ok({ batch });
  }),

  execute: asyncHandler(async (req: Request, res: Response) => {
    const batch = await createDataExecuteBatch({
      userId: userId(),
      id: String(req.params.id || ""),
      authToken: req.body?.authToken
        ? String(req.body.authToken)
        : undefined,
    });
    res.formatter.ok({ batch });
  }),

  rollback: asyncHandler(async (req: Request, res: Response) => {
    const batch = await createDataRollbackBatch({
      userId: userId(),
      id: String(req.params.id || ""),
      authToken: req.body?.authToken
        ? String(req.body.authToken)
        : undefined,
    });
    res.formatter.ok({ batch });
  }),
};
