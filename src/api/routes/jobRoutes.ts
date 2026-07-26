import { Router } from "express";
import { jobController } from "../controllers/jobController.js";

export const routePath = "/jobs";

/**
 * Job routes — method + path + middleware only.
 * Handlers live in jobController; logic in modules/job.
 *
 * Static segments are registered before `/:id/...` so paths like
 * `/start` or `/by-issue/7` are never captured as a job id.
 */
export function createJobRoutes(): Router {
  const router = Router();

  // —— Collection / static paths ——
  router.get("/", jobController.list);
  router.post("/start", jobController.start);
  router.post("/ensure", jobController.ensure);
  router.post("/adhoc", jobController.adhoc);
  router.get("/by-issue/:iid", jobController.byIssue);

  // —— Single job: sub-resources before the bare `/:id` ——
  router.get("/:id/issue-draft", jobController.issueDraft);
  router.post("/:id/create-issue", jobController.createIssue);
  router.put("/:id/dev-notes", jobController.updateDevNotes);

  router.get("/:id/docs", jobController.docs);
  router.post("/:id/approve-docs", jobController.approveDocs);
  router.post("/:id/rerun-docs", jobController.rerunDocs);

  router.post("/:id/completion-actions", jobController.completionActions);
  router.post("/:id/merge", jobController.merge);

  router.get("/:id/progress", jobController.progress);
  router.get("/:id/commits", jobController.commits);
  router.post("/:id/commits/:sha/revert", jobController.revertCommit);
  router.get("/:id/diff", jobController.diff);
  router.post("/:id/approve-diff", jobController.approveDiff);
  router.get("/:id/file", jobController.readFile);
  router.put("/:id/file", jobController.writeFile);
  router.get("/:id/linked", jobController.linked);

  router.post("/:id/kill", jobController.kill);
  router.post("/:id/reset-window", jobController.resetWindow);
  router.patch("/:id/status", jobController.setStatus);

  router.post("/:id/continue", jobController.continueChat);
  router.post("/:id/ask", jobController.ask);
  router.get("/:id/chat", jobController.chat);
  router.post("/:id/chat", jobController.appendChat);
  router.post("/:id/notes", jobController.addNote);

  // —— Bare `/:id` last ——
  router.get("/:id", jobController.detail);
  router.delete("/:id", jobController.remove);

  return router;
}
