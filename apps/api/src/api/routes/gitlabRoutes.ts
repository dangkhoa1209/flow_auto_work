import { Router } from "express";
import { gitlabController } from "../controllers/gitlabController.js";
import { projectController } from "../controllers/projectController.js";

export const routePath = "/gitlab";

export function createGitlabRoutes(): Router {
  const router = Router();
  router.get("/file", gitlabController.file);
  router.get("/my-projects", projectController.myGitlabProjects);
  router.get("/branches", projectController.branches);
  router.post("/preview", projectController.preview);
  return router;
}
