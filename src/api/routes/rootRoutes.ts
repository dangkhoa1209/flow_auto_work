import { Router } from "express";
import { fsController } from "../controllers/fsController.js";
import { gitlabController } from "../controllers/gitlabController.js";

/** Top-level paths under `/api` that are not namespaced. */
export const routePath = "/";

export function createRootRoutes(): Router {
  const router = Router();
  router.get("/context", fsController.context);
  router.get("/diff", gitlabController.diff);
  return router;
}
