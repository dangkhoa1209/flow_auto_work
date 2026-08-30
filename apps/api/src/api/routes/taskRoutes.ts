import { Router } from "express";
import { taskController } from "../controllers/taskController.js";

export const routePath = "/tasks";

export function createTaskRoutes(): Router {
  const router = Router();
  router.get("/", taskController.list);
  router.post("/update", taskController.update);
  router.get("/:iid", taskController.one);
  return router;
}
