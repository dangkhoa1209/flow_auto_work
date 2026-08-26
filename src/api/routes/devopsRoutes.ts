import { Router } from "express";
import { devopsController } from "../controllers/devopsController.js";
import { requireDevops } from "../middleware/devopsAuth.js";

export const routePath = "/devops";

export function createDevopsRoutes(): Router {
  const router = Router();
  router.use(requireDevops);

  router.get("/scripts", devopsController.listScripts);
  router.post("/scripts", devopsController.createScript);
  router.patch("/scripts/:scriptId", devopsController.updateScript);
  router.delete("/scripts/:scriptId", devopsController.deleteScript);
  router.get("/queue", devopsController.queue);
  router.get("/events", devopsController.events);

  router.get("/builds", devopsController.listBuilds);
  router.post("/builds", devopsController.trigger);
  router.get("/builds/:id", devopsController.getBuild);
  router.get("/builds/:id/log", devopsController.log);
  router.get("/builds/:id/stream", devopsController.stream);
  router.post("/builds/:id/cancel", devopsController.cancel);
  router.post("/builds/:id/stdin", devopsController.stdin);

  return router;
}
