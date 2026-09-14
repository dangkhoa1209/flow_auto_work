import { Router } from "express";
import { createDataController } from "../controllers/createDataController.js";
import { requireBa } from "../middleware/roleAuth.js";

export const routePath = "/ba/create-data";

export function createCreateDataRoutes(): Router {
  const router = Router();
  router.use(requireBa);

  router.post("/plan", createDataController.plan);
  router.get("/batches", createDataController.listBatches);
  router.post("/batches", createDataController.createBatch);
  router.get("/batches/:id", createDataController.getBatch);
  router.post("/batches/:id/execute", createDataController.execute);
  router.post("/batches/:id/rollback", createDataController.rollback);

  return router;
}
