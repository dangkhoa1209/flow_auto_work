import { Router } from "express";
import { qcController } from "../controllers/qcController.js";
import { requireQc, requireQcProject } from "../middleware/qcAuth.js";

export const routePath = "/qc";

export function createQcRoutes(): Router {
  const router = Router();
  router.use(requireQc);

  // Projects — no X-Qc-Project required
  router.get("/projects", qcController.listProjects);
  router.post("/projects", qcController.createProject);
  router.patch("/projects/:projectId", qcController.updateProject);
  router.delete("/projects/:projectId", qcController.deleteProject);

  // Scoped resources need X-Qc-Project
  const scoped = Router();
  scoped.use(requireQcProject);
  scoped.get("/flows", qcController.listFlows);
  scoped.post("/flows", qcController.createFlow);
  scoped.get("/flows/:flowId", qcController.getFlow);
  scoped.patch("/flows/:flowId", qcController.updateFlow);
  scoped.delete("/flows/:flowId", qcController.deleteFlow);

  scoped.get("/test-cases", qcController.listTestCases);
  scoped.post("/test-cases", qcController.createTestCase);
  scoped.get("/test-cases/:testCaseId", qcController.getTestCase);
  scoped.patch("/test-cases/:testCaseId", qcController.updateTestCase);
  scoped.delete("/test-cases/:testCaseId", qcController.deleteTestCase);

  scoped.get("/sample-files", qcController.listSampleFiles);
  scoped.post("/sample-files", qcController.uploadSampleFile);
  scoped.get("/sample-files/:fileId", qcController.downloadSampleFile);
  scoped.delete("/sample-files/:fileId", qcController.deleteSampleFile);

  router.use(scoped);
  return router;
}
