import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  getDiffPayload,
  proxyGitlabUpload,
} from "../../modules/gitlab/index.js";
import {
  headerProjectFromExpress,
  headerUserFromExpress,
} from "../middleware/workspaceAuth.js";

export const gitlabController = {
  file: asyncHandler(async (req: Request, res: Response) => {
    const username =
      headerUserFromExpress(req) ||
      String(req.query.user || "")
        .trim()
        .replace(/^@/, "");
    const projectId =
      headerProjectFromExpress(req) || String(req.query.project || "").trim();
    const { buffer, contentType } = await proxyGitlabUpload({
      rawUrl: String(req.query.u || ""),
      username,
      projectId,
      accessTokenQuery: String(req.query.access_token || ""),
    });
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(Buffer.from(buffer));
  }),

  diff: asyncHandler(async (req: Request, res: Response) => {
    const issueIid = req.query.issueIid
      ? Number(req.query.issueIid)
      : undefined;
    res.formatter.ok(await getDiffPayload(issueIid));
  }),
};
