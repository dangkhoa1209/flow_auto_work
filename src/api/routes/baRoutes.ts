import { Router } from "express";
import { baController } from "../controllers/baController.js";
import { requireBa } from "../middleware/roleAuth.js";

export const routePath = "/ba";

export function createBaRoutes(): Router {
  const router = Router();
  router.use(requireBa);

  router.get("/projects", baController.listProjects);
  router.get("/threads", baController.listThreads);
  router.post("/threads", baController.createThread);
  router.delete("/threads/:id", baController.deleteThread);
  router.get("/threads/:id/messages", baController.getMessages);
  router.post("/threads/:id/messages", baController.sendMessage);
  router.post("/threads/:id/stop", baController.stopThread);

  return router;
}
