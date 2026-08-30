import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as admin from "../../modules/admin/index.js";

export const adminController = {
  listProjects: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok({ projects: await admin.adminListBaProjects() });
  }),

  createProject: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.created(await admin.adminCreateBaProject(req.body || {}));
  }),

  updateProject: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await admin.adminUpdateBaProject(
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  deleteProject: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await admin.adminDeleteBaProject(String(req.params.id || "")));
  }),

  cloneProject: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await admin.adminCloneBaProject(
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  cloneStatus: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await admin.adminGetBaCloneStatus(String(req.params.id || "")));
  }),

  testDb: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await admin.adminTestBaProjectDb(String(req.params.id || "")));
  }),

  getCursor: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(await admin.adminGetCursorSettings());
  }),

  cursorModels: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(await admin.adminListCursorModels());
  }),

  putCursor: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await admin.adminUpdateCursorSettings(req.body || {}));
  }),

  getTaskTypeLabels: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(await admin.adminGetTaskTypeLabels());
  }),

  putTaskTypeLabels: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await admin.adminUpdateTaskTypeLabels(req.body || {}));
  }),

  getBaFeatures: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(await admin.adminGetBaFeatures());
  }),

  putBaFeatures: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(await admin.adminUpdateBaFeatures(req.body || {}));
  }),
};
