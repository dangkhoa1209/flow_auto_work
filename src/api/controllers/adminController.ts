import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as admin from "../../modules/admin/index.js";

export const adminController = {
  listProjects: asyncHandler(async (_req: Request, res: Response) => {
    res.json({ projects: await admin.adminListBaProjects() });
  }),

  createProject: asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await admin.adminCreateBaProject(req.body || {}));
  }),

  updateProject: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await admin.adminUpdateBaProject(
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  deleteProject: asyncHandler(async (req: Request, res: Response) => {
    res.json(await admin.adminDeleteBaProject(String(req.params.id || "")));
  }),

  cloneProject: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await admin.adminCloneBaProject(
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  cloneStatus: asyncHandler(async (req: Request, res: Response) => {
    res.json(await admin.adminGetBaCloneStatus(String(req.params.id || "")));
  }),

  getCursor: asyncHandler(async (_req: Request, res: Response) => {
    res.json(await admin.adminGetCursorSettings());
  }),

  putCursor: asyncHandler(async (req: Request, res: Response) => {
    res.json(await admin.adminUpdateCursorSettings(req.body || {}));
  }),
};
