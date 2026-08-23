import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireRoleContext } from "../middleware/roleAuth.js";
import * as ba from "../../modules/baChat/index.js";
import * as wb from "../../modules/baWorkbench/index.js";
import * as googleMod from "../../modules/google/index.js";

export const baController = {
  listProjects: asyncHandler(async (_req: Request, res: Response) => {
    res.json(await ba.baListProjects());
  }),

  getProjectGitlabMeta: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(
      await wb.baGetGitlabIssueMeta(
        username,
        String(req.params.id || ""),
      ),
    );
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

  draftIssueFromThread: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    const result = await wb.baDraftIssueFromThread(
      username,
      String(req.params.id || ""),
    );
    if (result.status === "started") {
      res.status(202).json(result);
      return;
    }
    res.json(result);
  }),

  listRequirements: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    const projectId = String(req.query.baProjectId || "").trim();
    res.json(await wb.baListRequirements(username, projectId || undefined));
  }),

  createRequirement: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.status(201).json(await wb.baCreateRequirement(username, req.body || {}));
  }),

  getRequirement: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await wb.baGetRequirement(username, String(req.params.id || "")));
  }),

  updateRequirement: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(
      await wb.baUpdateRequirement(
        username,
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  deleteRequirement: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await wb.baDeleteRequirement(username, String(req.params.id || "")));
  }),

  runWorkflowStep: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.status(202).json(
      await wb.baRunWorkflowStep(
        username,
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  stopWorkflow: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await wb.baStopWorkflow(username, String(req.params.id || "")));
  }),

  ensureRequirementThread: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(
      await wb.baEnsureRequirementThread(username, String(req.params.id || "")),
    );
  }),

  listTaskDrafts: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(
      await wb.baListTaskDrafts(username, {
        baProjectId: String(req.query.baProjectId || ""),
        requirementId: String(req.query.requirementId || ""),
        status: String(req.query.status || ""),
      }),
    );
  }),

  createTaskDraft: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.status(201).json(await wb.baCreateTaskDraft(username, req.body || {}));
  }),

  updateTaskDraft: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(
      await wb.baUpdateTaskDraft(
        username,
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  deleteTaskDraft: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await wb.baDeleteTaskDraft(username, String(req.params.id || "")));
  }),

  publishTaskDraft: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(
      await wb.baPublishTaskDraft(
        username,
        String(req.params.id || ""),
        req.body || {},
      ),
    );
  }),

  parseChatTask: asyncHandler(async (req: Request, res: Response) => {
    const content = String(req.body?.content || "").trim();
    res.json({ parsed: wb.parseTaskFromChatContent(content) });
  }),

  googleStatus: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await googleMod.getBaGoogleStatus(username));
  }),

  googleAuthUrl: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await googleMod.getBaGoogleAuthUrl(username));
  }),

  googleRevoke: asyncHandler(async (req: Request, res: Response) => {
    const { username } = requireRoleContext();
    res.json(await googleMod.revokeBaGoogleAuth(username));
  }),
};
