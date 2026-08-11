import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireRoleContext } from "../middleware/roleAuth.js";
import * as ba from "../../modules/baChat/index.js";

export const baController = {
  listProjects: asyncHandler(async (_req: Request, res: Response) => {
    res.json(await ba.baListProjects());
  }),

  listThreads: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    const projectId = String(req.query.baProjectId || "").trim();
    res.json(await ba.baListThreads(username, projectId || undefined));
  }),

  createThread: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.status(201).json(await ba.baCreateThread(username, req.body || {}));
  }),

  deleteThread: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(
      await ba.baDeleteThread(username, String(req.params.id || "")),
    );
  }),

  getMessages: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await ba.baGetMessages(username, String(req.params.id || "")));
  }),

  sendMessage: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.status(202).json(
      await ba.baSendMessage(
        username,
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  stopThread: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await ba.baStopThread(username, String(req.params.id || "")));
  }),
};
