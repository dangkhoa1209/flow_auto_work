import { Router } from "express";
import { notesController } from "../controllers/notesController.js";

export const routePath = "/notes";

export function createNotesRoutes(): Router {
  const router = Router();
  router.get("/", notesController.list);
  router.post("/", notesController.create);
  router.delete("/:noteId", notesController.delete);
  return router;
}
