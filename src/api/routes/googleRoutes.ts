import { Router } from "express";
import { googleController } from "../controllers/googleController.js";

export const routePath = "/google";

export function createGoogleRoutes(): Router {
  const router = Router();
  router.get("/auth-url", googleController.authUrl);
  router.get("/callback", googleController.callback);
  return router;
}
