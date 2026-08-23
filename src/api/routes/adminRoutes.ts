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
  router.post("/ba-projects/:id/test-db", adminController.testDb);

  router.get("/settings/cursor", adminController.getCursor);
  router.put("/settings/cursor", adminController.putCursor);

  router.get("/settings/task-type-labels", adminController.getTaskTypeLabels);
  router.put("/settings/task-type-labels", adminController.putTaskTypeLabels);

  router.get("/settings/ba-features", adminController.getBaFeatures);
  router.put("/settings/ba-features", adminController.putBaFeatures);

  return router;
}
