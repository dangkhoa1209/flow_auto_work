import { Router } from "express";
import { statusController } from "../controllers/statusController.js";

export const routePath = "/status";

export function createStatusRoutes(): Router {
  const router = Router();
  router.get("/", statusController.get);
  return router;
}
