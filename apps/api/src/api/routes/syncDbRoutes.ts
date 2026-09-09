import { Router } from "express";
import { syncDbController } from "../controllers/syncDbController.js";
import { requireBa } from "../middleware/roleAuth.js";

export const routePath = "/ba/sync-db";

export function createSyncDbRoutes(): Router {
  const router = Router();
  router.use(requireBa);

  router.get("/capability", syncDbController.capability);
  router.get("/queue", syncDbController.queue);
  router.get("/events", syncDbController.events);
  router.get("/jobs", syncDbController.listJobs);
  router.post("/jobs", syncDbController.trigger);
  router.get("/jobs/:id", syncDbController.getJob);
  router.get("/jobs/:id/log", syncDbController.log);
  router.get("/jobs/:id/stream", syncDbController.stream);
  router.post("/jobs/:id/cancel", syncDbController.cancel);

  return router;
}
