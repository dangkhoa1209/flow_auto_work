import { Router } from "express";
import { adminController } from "../controllers/adminController.js";
import { requireAdmin } from "../middleware/roleAuth.js";

export const routePath = "/admin";

export function createAdminRoutes(): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/ba-projects", adminController.listProjects);
  router.post("/ba-projects", adminController.createProject);
  router.patch("/ba-projects/:id", adminController.updateProject);
  router.delete("/ba-projects/:id", adminController.deleteProject);
  router.post("/ba-projects/:id/clone", adminController.cloneProject);
  router.get("/ba-projects/:id/clone-status", adminController.cloneStatus);

  router.get("/settings/cursor", adminController.getCursor);
  router.put("/settings/cursor", adminController.putCursor);

  return router;
}
