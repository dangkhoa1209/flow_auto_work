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
    res.json(
      getDefaultProjectPath(
        headerUserFromExpress(req),
        String(req.query.projectName || "project"),
      ),
    );
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CreateProjectBody;
    res.json(await createProject(headerUserFromExpress(req), body));
  }),

  join: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as JoinProjectBody;
    res.json(await joinProject(headerUserFromExpress(req), body));
  }),

  clone: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CloneProjectBody;
    res.json(
      await startProjectClone(
        headerUserFromExpress(req),
        projectIdParam(req),
        body,
      ),
    );
  }),

  cloneStatus: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await getProjectCloneStatus(
        headerUserFromExpress(req),
        projectIdParam(req),
      ),
    );
  }),

  activate: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await activateUserProject(
        headerUserFromExpress(req),
        projectIdParam(req),
      ),
    );
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await removeUserProject(headerUserFromExpress(req), projectIdParam(req)),
    );
  }),

  /** PUT /me/projects/:projectId — update branches / path / token / Flow name */
  updateOwned: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as UpdateProjectBody;
    res.json(
      await updateOwnedProject(
        headerUserFromExpress(req),
        projectIdParam(req),
        body,
      ),
    );
  }),

  ownedMilestones: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await listOwnedProjectMilestones(
        headerUserFromExpress(req),
        projectIdParam(req),
      ),
    );
  }),

  myGitlabProjects: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await listMyGitlabProjectsForUser(
        headerUserFromExpress(req),
        headerProjectFromExpress(req),
      ),
    );
  }),

  branches: asyncHandler(async (req: Request, res: Response) => {
    res.json(
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
    res.json(await previewGitlab(headerUserFromExpress(req), body));
  }),
};
