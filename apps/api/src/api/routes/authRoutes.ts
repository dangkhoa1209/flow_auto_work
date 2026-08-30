import { Router } from "express";
import { authController } from "../controllers/authController.js";

export const routePath = "/auth";

export function createAuthRoutes(): Router {
  const router = Router();
  router.get("/bootstrap", authController.bootstrap);
  router.post("/resolve-token", authController.resolveToken);
  router.post("/register", authController.register);
  router.post("/login", authController.login);
  router.post("/refresh", authController.refresh);
  router.post("/logout", authController.logout);
  return router;
}
