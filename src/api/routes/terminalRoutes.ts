import { Router } from "express";
import { terminalController } from "../controllers/terminalController.js";

export const routePath = "/terminal";

export function createTerminalRoutes(): Router {
  const router = Router();
  router.get("/status", terminalController.status);
  return router;
}
