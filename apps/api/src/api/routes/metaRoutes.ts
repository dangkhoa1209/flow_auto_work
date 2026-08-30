import { Router } from "express";
import { metaController } from "../controllers/metaController.js";

export const routePath = "/meta";

export function createMetaRoutes(): Router {
  const router = Router();
  router.get("/completion-defaults", metaController.completionDefaults);
  router.get("/members", metaController.members);
  router.get("/labels", metaController.labels);
  router.get("/milestones", metaController.milestones);
  return router;
}
