import { Router } from "express";
import { projectController } from "../controllers/projectController.js";

export const routePath = "/projects";

export function createProjectRoutes(): Router {
  const router = Router();
  router.get("/default-path", projectController.defaultPath);
  router.post("/join", projectController.join);
  router.post("/", projectController.create);
  router.post("/:projectId/clone", projectController.clone);
  router.get("/:projectId/clone-status", projectController.cloneStatus);
  router.post("/:projectId/activate", projectController.activate);
  router.delete("/:projectId", projectController.remove);
  return router;
}
