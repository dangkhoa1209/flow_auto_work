import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApiRoutes } from "./api/routes.js";
import { getConfig } from "./config.js";
import { filterIssueHook, type GitlabIssueHookPayload } from "./gitlab/filter.js";
import { verifyGitlabToken } from "./gitlab/verify.js";
import { issueKey, listActiveIssueKeys } from "./job-store.js";
import { logger } from "./logger.js";
import { jobQueue } from "./queue.js";

export function createApp() {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      ingest: getConfig().INGEST_MODE,
      teamsEnabled: getConfig().teamsEnabled,
      ui: "/",
    }),
  );

  app.route("/api", createApiRoutes());

  app.post("/webhooks/gitlab", async (c) => {
    const config = getConfig();
    const token = c.req.header("X-Gitlab-Token");
    if (!verifyGitlabToken(token, config.GITLAB_WEBHOOK_SECRET)) {
      logger.warn("Rejected webhook: bad token");
      return c.json({ error: "unauthorized" }, 401);
    }

    const event = c.req.header("X-Gitlab-Event");
    let payload: GitlabIssueHookPayload;
    try {
      payload = (await c.req.json()) as GitlabIssueHookPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const filtered = filterIssueHook(event ?? undefined, payload, config);
    if (!filtered.accept) {
      logger.info("Webhook ignored", { reason: filtered.reason, event });
      return c.json({ accepted: false, reason: filtered.reason });
    }

    if (!config.WEBHOOK_AUTO_ENQUEUE) {
      logger.info("Webhook accepted but not enqueued (UI-only mode)", {
        issueIid: filtered.job.issueIid,
      });
      return c.json({
        accepted: false,
        reason: "ui_only — start from UI",
        issueIid: filtered.job.issueIid,
      });
    }

    const active = await listActiveIssueKeys();
    const key = issueKey(filtered.job.projectId, filtered.job.issueIid);
    if (active.has(key)) {
      logger.info("Dedup skip — issue already active", { key });
      return c.json({ accepted: false, reason: "already active" });
    }

    const result = await jobQueue.enqueue(filtered.job, { source: "webhook" });

    return c.json({
      accepted: result.enqueued,
      jobId: result.jobId,
      reason: result.reason,
    });
  });

  app.use(
    "/*",
    serveStatic({
      root: "./public",
      index: "index.html",
    }),
  );

  return app;
}
