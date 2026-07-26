import { Router } from "express";
import { statsController } from "../controllers/statsController.js";

export const routePath = "/stats";

export function createStatsRoutes(): Router {
  const router = Router();
  router.get("/daily", statsController.daily);
  return router;
}
