import { Router } from "express";
import { jobController } from "../controllers/jobController.js";

/**
 * Job routes — method + path + middleware only.
 * Handlers live in jobController; logic in services/jobService.
 */
export function createJobRoutes(): Router {
  const router = Router();

  router.get("/", jobController.list);
  router.post("/start", jobController.start);

  return router;
}
