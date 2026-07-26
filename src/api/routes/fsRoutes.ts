import { Router } from "express";
import { fsController } from "../controllers/fsController.js";

export const routePath = "/fs";

export function createFsRoutes(): Router {
  const router = Router();
  router.get("/browse", fsController.browse);
  return router;
}
