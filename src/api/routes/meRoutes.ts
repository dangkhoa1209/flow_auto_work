import { Router } from "express";
import { meController } from "../controllers/meController.js";
import { projectController } from "../controllers/projectController.js";

export const routePath = "/me";

export function createMeRoutes(): Router {
  const router = Router();
  router.get("/", meController.get);
  router.put("/secrets", meController.updateSecrets);
  router.put("/preferences", meController.updatePreferences);
  router.get("/handoff-prefs", meController.getHandoffPrefs);
  router.put("/handoff-prefs", meController.updateHandoffPrefs);
  router.get("/cursor-models", meController.cursorModels);
  router.delete("/cursor-key", meController.clearCursorKey);
  router.put("/qc-role", meController.setQcRole);
  router.put("/projects/:projectId", projectController.updateOwned);
  return router;
}
