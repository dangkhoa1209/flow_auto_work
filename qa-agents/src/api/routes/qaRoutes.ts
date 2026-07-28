import { Router } from "express";
import { asyncHandler } from "../../../../src/utils/asyncHandler.js";
import * as qa from "../../modules/qa/index.js";

function paramId(req: { params: { id?: string | string[] } }): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? String(raw[0] || "") : String(raw || "");
}

export function createQaRoutes(): Router {
  const router = Router();

  router.get(
    "/config",
    asyncHandler(async (_req, res) => {
      res.json({ config: await qa.getConfigForCurrentProject() });
    }),
  );

  router.put(
    "/config",
    asyncHandler(async (req, res) => {
      const config = await qa.saveConfigForCurrentProject(req.body || {});
      res.json({ config });
    }),
  );

  router.get(
    "/presets",
    asyncHandler(async (_req, res) => {
      res.json({ presets: await qa.listPresetsForCurrentProject() });
    }),
  );

  router.post(
    "/presets",
    asyncHandler(async (req, res) => {
      const preset = await qa.addPreset({
        role: String(req.body?.role || ""),
        username: String(req.body?.username || ""),
        password: String(req.body?.password || ""),
      });
      res.status(201).json({ preset });
    }),
  );

  router.patch(
    "/presets/:id",
    asyncHandler(async (req, res) => {
      const preset = await qa.patchPreset(paramId(req), {
        role: req.body?.role,
        username: req.body?.username,
        password: req.body?.password,
      });
      res.json({ preset });
    }),
  );

  router.delete(
    "/presets/:id",
    asyncHandler(async (req, res) => {
      res.json(await qa.removePreset(paramId(req)));
    }),
  );

  router.get(
    "/jobs",
    asyncHandler(async (_req, res) => {
      res.json(await qa.listJobsForCurrentProject());
    }),
  );

  router.post(
    "/jobs",
    asyncHandler(async (req, res) => {
      const job = await qa.createAndEnqueueJob({
        targetUrl: String(req.body?.targetUrl || ""),
        presetId: String(req.body?.presetId || ""),
        testcase: String(req.body?.testcase || ""),
      });
      res.status(201).json({ job });
    }),
  );

  router.get(
    "/jobs/:id",
    asyncHandler(async (req, res) => {
      res.json({ job: await qa.getJob(paramId(req)) });
    }),
  );

  router.post(
    "/jobs/:id/adjust",
    asyncHandler(async (req, res) => {
      const job = await qa.adjustJob(paramId(req), String(req.body?.note || ""));
      res.json({ job });
    }),
  );

  router.post(
    "/jobs/:id/approve",
    asyncHandler(async (req, res) => {
      const result = await qa.approveJob(paramId(req), {
        title: req.body?.title,
        description: req.body?.description,
        assignees: req.body?.assignees,
        labels: req.body?.labels,
        milestoneId:
          req.body?.milestoneId != null
            ? Number(req.body.milestoneId)
            : undefined,
      });
      res.json(result);
    }),
  );

  router.post(
    "/jobs/:id/kill",
    asyncHandler(async (req, res) => {
      res.json({ job: await qa.killJob(paramId(req)) });
    }),
  );

  router.get(
    "/meta",
    asyncHandler(async (_req, res) => {
      res.json(await qa.metaMembersLabelsMilestones());
    }),
  );

  return router;
}
