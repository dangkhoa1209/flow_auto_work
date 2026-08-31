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
  router.get("/cursor-pats", meController.cursorPats);
  router.post("/cursor-pats", meController.createCursorPat);
  router.put("/cursor-pats/:patId", meController.updateCursorPat);
  router.put("/cursor-pats/:patId/active", meController.activateCursorPat);
  router.delete("/cursor-pats/:patId", meController.deleteCursorPat);
  router.delete("/cursor-key", meController.clearCursorKey);
  router.put("/qc-role", meController.setQcRole);
  router.get("/google/status", meController.googleStatus);
  router.get("/google/auth-url", meController.googleAuthUrl);
  router.post("/google/revoke", meController.googleRevoke);
  router.put("/integrations", meController.updateIntegrations);
  router.put("/password", meController.changePassword);
  router.put("/projects/:projectId", projectController.updateOwned);
  router.get(
    "/projects/:projectId/milestones",
    projectController.ownedMilestones,
  );
  return router;
}
