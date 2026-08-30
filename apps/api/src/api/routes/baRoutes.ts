import { Router } from "express";
import { baController } from "../controllers/baController.js";
import { requireBa } from "../middleware/roleAuth.js";

export const routePath = "/ba";

export function createBaRoutes(): Router {
  const router = Router();
  router.use(requireBa);

  router.get("/projects", baController.listProjects);
  router.get("/projects/:id/gitlab-meta", baController.getProjectGitlabMeta);
  router.get("/threads", baController.listThreads);
  router.post("/threads", baController.createThread);
  router.delete("/threads/:id", baController.deleteThread);
  router.get("/threads/:id/messages", baController.getMessages);
  router.post("/threads/:id/messages", baController.sendMessage);
  router.post("/threads/:id/stop", baController.stopThread);
  router.post("/threads/:id/draft-issue", baController.draftIssueFromThread);

  router.get("/requirements", baController.listRequirements);
  router.post("/requirements", baController.createRequirement);
  router.get("/requirements/:id", baController.getRequirement);
  router.patch("/requirements/:id", baController.updateRequirement);
  router.delete("/requirements/:id", baController.deleteRequirement);
  router.post("/requirements/:id/run-step", baController.runWorkflowStep);
  router.post("/requirements/:id/stop", baController.stopWorkflow);
  router.post(
    "/requirements/:id/ensure-thread",
    baController.ensureRequirementThread,
  );

  router.get("/task-drafts", baController.listTaskDrafts);
  router.post("/task-drafts/parse-chat", baController.parseChatTask);
  router.post("/task-drafts", baController.createTaskDraft);
  router.patch("/task-drafts/:id", baController.updateTaskDraft);
  router.delete("/task-drafts/:id", baController.deleteTaskDraft);
  router.post("/task-drafts/:id/publish", baController.publishTaskDraft);

  router.get("/google/status", baController.googleStatus);
  router.get("/google/auth-url", baController.googleAuthUrl);
  router.post("/google/revoke", baController.googleRevoke);

  return router;
}
