import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  activateUserProject,
  createProject,
  getDefaultProjectPath,
  getProjectCloneStatus,
  joinProject,
  listMyGitlabProjectsForUser,
  listOwnedProjectMilestones,
  listProjectBranches,
  previewGitlab,
  removeUserProject,
  startProjectClone,
  updateOwnedProject,
  type CloneProjectBody,
  type CreateProjectBody,
  type JoinProjectBody,
  type UpdateProjectBody,
} from "../../modules/project/index.js";
import {
  headerProjectFromExpress,
  headerUserFromExpress,
} from "../middleware/workspaceAuth.js";

function projectIdParam(req: Request): string {
  return decodeURIComponent(String(req.params.projectId || "")).trim();
}

export const projectController = {
  defaultPath: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      getDefaultProjectPath(
        headerUserFromExpress(req),
        String(req.query.projectName || "project"),
      ),
    );
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CreateProjectBody;
    res.formatter.ok(await createProject(headerUserFromExpress(req), body));
  }),

  join: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as JoinProjectBody;
    res.formatter.ok(await joinProject(headerUserFromExpress(req), body));
  }),

  clone: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CloneProjectBody;
    res.formatter.ok(
      await startProjectClone(
        headerUserFromExpress(req),
        projectIdParam(req),
        body,
      ),
    );
  }),

  cloneStatus: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await getProjectCloneStatus(
        headerUserFromExpress(req),
        projectIdParam(req),
      ),
    );
  }),

  activate: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await activateUserProject(
        headerUserFromExpress(req),
        projectIdParam(req),
      ),
    );
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await removeUserProject(headerUserFromExpress(req), projectIdParam(req)),
    );
  }),

  /** PUT /me/projects/:projectId — update branches / path / token / Flow name */
  updateOwned: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as UpdateProjectBody;
    res.formatter.ok(
      await updateOwnedProject(
        headerUserFromExpress(req),
        projectIdParam(req),
        body,
      ),
    );
  }),

  ownedMilestones: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await listOwnedProjectMilestones(
        headerUserFromExpress(req),
        projectIdParam(req),
      ),
    );
  }),

  myGitlabProjects: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await listMyGitlabProjectsForUser(
        headerUserFromExpress(req),
        headerProjectFromExpress(req),
      ),
    );
  }),

  branches: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await listProjectBranches({
        username: headerUserFromExpress(req),
        gitlabPath: String(req.query.gitlabPath || ""),
        repoPath: String(req.query.repoPath || ""),
        projectId:
          String(req.query.projectId || "").trim() ||
          headerProjectFromExpress(req),
      }),
    );
  }),

  preview: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      gitlabToken?: string;
      gitlabPath?: string;
    };
    res.formatter.ok(await previewGitlab(headerUserFromExpress(req), body));
  }),
};
