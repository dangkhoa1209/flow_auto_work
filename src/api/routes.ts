import { Hono } from "hono";
import { answerTaskQuestion } from "../agent/qa.js";
import { getJobProgress } from "../agent/progress.js";
import {
  listPendingClarifications,
  submitUiClarification,
} from "../clarify/ui-wait.js";
import {
  isAwaitingDiffApproval,
  listPendingDiffApprovals,
  submitDiffApproval,
} from "../review/diff-wait.js";
import {
  extractPathsFromUnifiedDiff,
  readRepoFile,
  writeRepoFile,
} from "../git/files.js";
import { getConfig } from "../config.js";
import { getReviewDiff } from "../git/diff.js";
import {
  addChatMessage,
  addNote,
  deleteJobDoc,
  deleteJobSideDocs,
  getJobDoc,
  listChatMessages,
  listJobDocs,
  listNotes,
  mongoPing,
} from "../db/mongo.js";
import {
  ensureJob,
  loadJob,
  loadJobByIssue,
  listJobs,
  saveJob,
  createAdhocJob,
  migrateAdhocJobToIssue,
} from "../job-store.js";
import { logger } from "../logger.js";
import { jobQueue } from "../queue.js";
import {
  isAdhocJob,
  isJobBusy,
  resolveDevNotes,
  type CompletionActions,
  type IssueJob,
  type JobStatus,
} from "../types.js";
import {
  createWorkspaceRoutes,
  headerProject,
  headerUser,
  withWorkspaceContext,
} from "../workspace/routes.js";
import {
  commentOnIssue,
  createIssue,
  listAssignedOpenIssues,
  fetchIssueAsJob,
} from "../gitlab/client.js";
import { scanExistingAssignedIssues } from "../gitlab/startup-scan.js";

export function createApiRoutes() {
  const api = new Hono();

  // Auth / workspace (no project context required for login/join)
  api.route("/", createWorkspaceRoutes());

  api.get("/status", async (c) => {
    const config = getConfig();
    const mongoOk = await mongoPing();
    const queue = jobQueue.snapshot();
    return c.json({
      ok: true,
      mongo: mongoOk,
      project: config.ALLOWED_PROJECT_PATH ?? null,
      assignee: config.GITLAB_ASSIGNEE_USERNAME ?? null,
      multiUser: true,
      secretsEncrypted: true,
      queue,
      // Flat fields for UI header (also pushed via SSE)
      currentJobId: queue.currentJobId,
      queueLength: queue.queued,
      pendingClarifications: listPendingClarifications(),
    });
  });

  /**
   * Realtime channel (SSE). UI listens instead of polling /status + /jobs.
   * EventSource cannot set custom headers → optional ?u=&p= for future filter.
   */
  api.get("/events", async (c) => {
    const { streamSSE } = await import("hono/streaming");
    const { subscribeRealtime } = await import("../realtime/hub.js");
    return streamSSE(c, async (stream) => {
      let closed = false;
      const send = async (event: string, data: unknown) => {
        if (closed) return;
        try {
          await stream.writeSSE({
            event,
            data: JSON.stringify(data),
          });
        } catch {
          closed = true;
        }
      };

      // Hello + current queue snapshot
      const snap = jobQueue.snapshot();
      await send("status", {
        type: "status",
        currentJobId: snap.currentJobId,
        queueLength: snap.queued,
        running: snap.running,
      });
      await send("hello", { ok: true, at: new Date().toISOString() });

      const unsub = subscribeRealtime((ev) => {
        void send(ev.type, ev);
      });

      const heartbeat = setInterval(() => {
        void send("ping", { at: new Date().toISOString() });
      }, 20_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          closed = true;
          clearInterval(heartbeat);
          unsub();
          resolve();
        });
      });
    });
  });

  /**
   * Proxy GitLab /uploads/… images (browser <img> cannot send PAT).
   * Query: u=<absolute upload url>&user=&project= (user/project for <img> without headers).
   */
  api.get("/gitlab/file", async (c) => {
    const raw = (c.req.query("u") || "").trim();
    if (!raw) return c.text("u required", 400);

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return c.text("invalid u", 400);
    }

    const config = getConfig();
    const gitlabRoot = config.GITLAB_BASE_URL.replace(/\/$/, "");
    let gitlabHost: string;
    try {
      gitlabHost = new URL(gitlabRoot).host;
    } catch {
      return c.text("bad GITLAB_BASE_URL", 500);
    }
    if (target.host !== gitlabHost) {
      return c.text("host not allowed", 403);
    }
    if (!/\/uploads\//i.test(target.pathname)) {
      return c.text("only /uploads/ paths allowed", 403);
    }

    const username =
      headerUser(c) ||
      (c.req.query("user") || "").trim().replace(/^@/, "");
    const projectId =
      headerProject(c) || (c.req.query("project") || "").trim();
    if (!username || !projectId) {
      return c.text("user + project required", 401);
    }

    // Prefer access_token on query (img cannot send Authorization)
    const accessQ = (c.req.query("access_token") || "").trim();
    if (accessQ) {
      try {
        const { verifyAccessToken } = await import("../auth/tokens.js");
        const sub = verifyAccessToken(accessQ).sub;
        if (sub !== username.trim().replace(/^@/, "").toLowerCase()) {
          return c.text("token user mismatch", 403);
        }
      } catch {
        return c.text("access token expired", 401);
      }
    }

    try {
      return await withWorkspaceContext(username, projectId, async () => {
        const { resolveGitlabToken } = await import("../workspace/creds.js");
        const token = resolveGitlabToken();
        const upstream = await fetch(target.toString(), {
          headers: {
            "PRIVATE-TOKEN": token,
            Accept: "*/*",
          },
        });
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          logger.warn("GitLab upload proxy failed", {
            status: upstream.status,
            path: target.pathname,
            detail: detail.slice(0, 200),
          });
          return c.text(`gitlab ${upstream.status}`, upstream.status as 404);
        }
        const contentType =
          upstream.headers.get("content-type") || "application/octet-stream";
        const buf = await upstream.arrayBuffer();
        return new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "private, max-age=300",
          },
        });
      });
    } catch (err) {
      logger.warn("GitLab upload proxy error", { err: String(err) });
      return c.text(err instanceof Error ? err.message : String(err), 401);
    }
  });

  /** Require login + project; decrypt tokens into AsyncLocalStorage */
  api.use("*", async (c, next) => {
    const path = c.req.path;
    if (
      path === "/status" ||
      path === "/events" ||
      path.startsWith("/auth/") ||
      path === "/me" ||
      path.startsWith("/me/") ||
      path.startsWith("/projects/") ||
      path.startsWith("/gitlab/") ||
      path === "/context"
    ) {
      return next();
    }
    const { verifyAccessToken } = await import("../auth/tokens.js");
    const bearer = (c.req.header("Authorization") || "").trim();
    let username = "";
    if (bearer.toLowerCase().startsWith("bearer ")) {
      try {
        username = verifyAccessToken(bearer.slice(7).trim()).sub;
      } catch (err) {
        return c.json(
          {
            error:
              err instanceof Error ? err.message : "Invalid or expired access token",
            code: "access_expired",
          },
          401,
        );
      }
    }
    if (!username) {
      // Legacy header only when no Bearer (onboarding mid-login before tokens rare)
      username = headerUser(c);
    }
    const projectId = headerProject(c);
    if (!username || !projectId) {
      return c.json(
        {
          error:
            "Bearer access token + X-Flow-Project required — login and select a project",
          code: "unauthorized",
        },
        401,
      );
    }
    try {
      await withWorkspaceContext(username, projectId, async () => {
        await next();
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        401,
      );
    }
  });

  api.get("/tasks", async (c) => {
    const config = getConfig();
    const issues = await listAssignedOpenIssues();
    const tasks = issues.map((issue) => {
      const skip = issue.labels.some((l) =>
        config.skipLabels.includes(l.toLowerCase()),
      );
      return { ...issue, skip };
    });
    return c.json({ tasks, count: tasks.length });
  });

  api.get("/tasks/:iid", async (c) => {
    const iid = Number(c.req.param("iid"));
    if (!Number.isFinite(iid) || iid <= 0) {
      return c.json({ error: "invalid iid" }, 400);
    }
    const { getIssueUiDetail } = await import("../gitlab/client.js");
    try {
      const detail = await getIssueUiDetail(iid);
      return c.json({ detail });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  });

  api.post("/jobs/start", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: string;
      issueIid?: number;
      issueIids?: number[];
      /** Run all assigned tasks (re-run); skip busy; create job if missing */
      runDrafts?: boolean;
      runAll?: boolean;
      devNotes?: string;
      techLeadNotes?: string;
      requireDocsFirst?: boolean;
      completion?: CompletionActions;
    };
    const mode =
      body.mode === "selected" || body.mode === "manual"
        ? "selected"
        : body.mode === "drafts" ||
            body.mode === "all" ||
            body.runDrafts ||
            body.runAll
          ? "all"
          : "auto";
    const devNotes =
      body.devNotes?.trim() || body.techLeadNotes?.trim() || undefined;
    const requireDocsFirst =
      body.requireDocsFirst !== undefined
        ? Boolean(body.requireDocsFirst)
        : undefined;
    const completion = body.completion
      ? {
          assignees: body.completion.assignees
            ?.map((s) => String(s).trim())
            .filter(Boolean),
          labels: body.completion.labels
            ?.map((s) => String(s).trim())
            .filter(Boolean),
          removeLabels: body.completion.removeLabels
            ?.map((s) => String(s).trim())
            .filter(Boolean),
          onStartLabels: body.completion.onStartLabels
            ?.map((s) => String(s).trim())
            .filter(Boolean),
          processingLabel:
            body.completion.processingLabel?.trim() || undefined,
          labelMode:
            body.completion.labelMode === "set"
              ? ("set" as const)
              : ("add" as const),
          comment: body.completion.comment?.trim() || undefined,
        }
      : undefined;

    if (mode === "all") {
      const config = getConfig();
      const issues = await listAssignedOpenIssues();
      const existingJobs = await listJobs();
      const jobByIid = new Map(
        existingJobs.map((j) => [j.issue.issueIid, j] as const),
      );

      let enqueued = 0;
      let skipped = 0;
      let skippedBusy = 0;
      let created = 0;
      const jobIds: string[] = [];

      for (const issue of issues) {
        if (
          issue.labels.some((l) => config.skipLabels.includes(l.toLowerCase()))
        ) {
          skipped += 1;
          continue;
        }

        const existing = jobByIid.get(issue.issueIid);
        if (existing && isJobBusy(existing.status)) {
          skippedBusy += 1;
          skipped += 1;
          continue;
        }

        const wasMissing = !existing;
        const result = await jobQueue.enqueue(issue, {
          source: "ui_run_all",
          completion: completion ?? existing?.completion,
          devNotes:
            resolveDevNotes(existing ?? { devNotes: undefined }) || undefined,
          requireDocsFirst: existing?.requireDocsFirst,
        });
        if (result.enqueued && result.jobId) {
          enqueued += 1;
          if (wasMissing) created += 1;
          jobIds.push(result.jobId);
        } else {
          skipped += 1;
        }
      }

      return c.json({
        mode: "all",
        found: issues.length,
        enqueued,
        skipped,
        skippedBusy,
        created,
        jobIds,
      });
    }

    if (mode === "auto") {
      if (!completion && !devNotes) {
        const result = await scanExistingAssignedIssues({
          source: "ui_auto",
          includeSucceeded: false,
        });
        return c.json({ mode, ...result });
      }
      const all = await listAssignedOpenIssues();
      const config = getConfig();
      let enqueued = 0;
      let skipped = 0;
      const jobIds: string[] = [];
      for (const issue of all) {
        if (
          issue.labels.some((l) => config.skipLabels.includes(l.toLowerCase()))
        ) {
          skipped += 1;
          continue;
        }
        const result = await jobQueue.enqueue(issue, {
          source: "ui_auto",
          completion,
          devNotes,
        });
        if (result.enqueued && result.jobId) {
          enqueued += 1;
          jobIds.push(result.jobId);
        } else skipped += 1;
      }
      return c.json({
        mode,
        found: all.length,
        enqueued,
        skipped,
        jobIds,
      });
    }

    const iids = Array.isArray(body.issueIids)
      ? body.issueIids.map(Number).filter((n) => !Number.isNaN(n))
      : [];
    if (body.issueIid != null && !Number.isNaN(Number(body.issueIid))) {
      const one = Number(body.issueIid);
      if (!iids.includes(one)) iids.push(one);
    }
    if (iids.length === 0) {
      return c.json(
        { error: "issueIid or issueIids required for mode=selected|manual" },
        400,
      );
    }

    const all = await listAssignedOpenIssues();
    const config = getConfig();
    const selected = all.filter((i) => iids.includes(i.issueIid));
    let enqueued = 0;
    let skipped = 0;
    const jobIds: string[] = [];

    for (const issue of selected) {
      if (issue.labels.some((l) => config.skipLabels.includes(l.toLowerCase()))) {
        skipped += 1;
        continue;
      }
      const result = await jobQueue.enqueue(issue, {
        source: "ui_selected",
        completion,
        // Single-issue Run: attach notes; multi: same notes only if provided
        devNotes: iids.length === 1 ? devNotes : undefined,
        requireDocsFirst:
          iids.length === 1 ? requireDocsFirst : undefined,
      });
      if (result.enqueued && result.jobId) {
        enqueued += 1;
        jobIds.push(result.jobId);
      } else {
        skipped += 1;
      }
    }

    const missing = iids.filter((id) => !selected.some((s) => s.issueIid === id));
    return c.json({
      mode,
      found: selected.length,
      enqueued,
      skipped,
      missing,
      jobIds,
    });
  });

  /** Open/create the unique job for an issue (status draft if new) */
  api.post("/jobs/ensure", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      issueIid?: number;
      devNotes?: string;
      requireDocsFirst?: boolean;
    };
    const iid = Number(body.issueIid);
    if (!Number.isFinite(iid) || iid <= 0) {
      return c.json({ error: "issueIid required" }, 400);
    }
    // Prefer assignee list (fresh), else fetch any issue by iid (Related/child),
    // else reuse existing job snapshot.
    const all = await listAssignedOpenIssues();
    let issue = all.find((i) => i.issueIid === iid) ?? null;
    if (!issue) {
      issue = await fetchIssueAsJob(iid);
    }
    if (!issue) {
      const existing = (await listJobs()).find((j) => j.issue.issueIid === iid);
      if (!existing) return c.json({ error: `Issue #${iid} not found` }, 404);
      if (body.devNotes !== undefined) {
        existing.devNotes = body.devNotes.trim() || undefined;
      }
      if (body.requireDocsFirst !== undefined) {
        existing.requireDocsFirst = Boolean(body.requireDocsFirst);
      }
      await saveJob(existing);
      return c.json({ job: existing });
    }
    const job = await ensureJob(issue, {
      source: "ui_ensure",
      devNotes: body.devNotes,
      requireDocsFirst: body.requireDocsFirst,
    });
    return c.json({ job });
  });

  /** Free Hotfix / ad-hoc agent session (no GitLab issue yet). */
  api.post("/jobs/adhoc", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      message?: string;
      labels?: string[];
    };
    const title = body.title?.trim();
    if (!title) return c.json({ error: "title required" }, 400);
    try {
      const job = await createAdhocJob({
        title,
        labels: body.labels,
        source: "ui_adhoc",
      });
      const message = body.message?.trim();
      if (message) {
        // Fire follow-up async so UI can select job + stream progress
        void jobQueue.followUpChat(job.id, message).catch((err) => {
          logger.error("Adhoc first message failed", {
            jobId: job.id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return c.json({ job, started: Boolean(message) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Create adhoc job failed", { err: msg });
      return c.json({ error: msg }, 500);
    }
  });

  /** Prefill suggestion for «Tạo issue GitLab» modal */
  api.get("/jobs/:id/issue-draft", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    if (!isAdhocJob(job)) {
      return c.json({ error: "Only adhoc sessions can create a new issue" }, 400);
    }
    const chat = await listChatMessages({ jobId: job.id, limit: 40 });
    const humanBits = chat
      .filter((m) => m.role === "user" && m.body?.trim())
      .map((m) => m.body.trim())
      .slice(-5);
    const agentBits = chat
      .filter((m) => m.role === "agent" && m.body?.trim())
      .map((m) => m.body.trim())
      .slice(-3);
    const summary = (job.summary || "").trim();
    const title =
      job.issue.title?.trim() ||
      summary.split("\n")[0]?.slice(0, 120) ||
      "Hotfix session";
    const parts: string[] = [];
    if (summary) parts.push(`## Summary\n${summary}`);
    if (humanBits.length) {
      parts.push(
        `## Requests\n${humanBits.map((b) => `- ${b.slice(0, 500)}`).join("\n")}`,
      );
    }
    if (agentBits.length) {
      parts.push(
        `## Agent notes\n${agentBits.map((b) => b.slice(0, 800)).join("\n\n---\n\n")}`,
      );
    }
    if (job.branch) parts.push(`## Branch\n\`${job.branch}\``);
    if (job.commitSha) parts.push(`## Commit\n\`${job.commitSha.slice(0, 8)}\``);
    return c.json({
      title,
      description: parts.join("\n\n") || title,
      labels: job.issue.labels || [],
      branch: job.branch || null,
      commitSha: job.commitSha || null,
      summary: summary || null,
    });
  });

  /** Create GitLab issue from adhoc session and migrate job id. */
  api.post("/jobs/:id/create-issue", async (c) => {
    const loaded = await loadJob(c.req.param("id"));
    if (!loaded) return c.json({ error: "not found" }, 404);
    if (!isAdhocJob(loaded)) {
      return c.json({ error: "Only adhoc sessions can create a new issue" }, 400);
    }
    if (isJobBusy(loaded.status)) {
      return c.json(
        { error: "Agent đang chạy — đợi xong rồi tạo issue" },
        409,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      description?: string;
      labels?: string[];
      assignee?: string;
    };
    const title = body.title?.trim() || loaded.issue.title?.trim();
    if (!title) return c.json({ error: "title required" }, 400);
    const description = body.description?.trim() || "";
    const labels = body.labels?.length
      ? body.labels
      : loaded.issue.labels || [];

    const { getRuntimeContext } = await import("../workspace/runtime.js");
    const rt = getRuntimeContext();
    const assignee =
      body.assignee?.trim().replace(/^@/, "") ||
      loaded.ownerUsername?.trim() ||
      rt?.gitlabUsername?.trim() ||
      "";

    try {
      const created = await createIssue({
        title,
        description,
        labels,
        assignees: assignee ? [assignee] : undefined,
        projectIdOrPath: loaded.issue.projectId || loaded.issue.projectPath,
      });

      const issue: IssueJob = {
        projectId: created.projectId,
        projectPath: loaded.issue.projectPath,
        issueIid: created.iid,
        issueId: created.id,
        title: created.title,
        description: created.description,
        labels: created.labels.length ? created.labels : labels,
        url: created.webUrl,
        action: "adhoc_linked",
      };

      const migrated = await migrateAdhocJobToIssue(loaded, issue);

      const commentParts = [
        "Linked from Flow Auto Work ad-hoc / Hotfix session.",
      ];
      if (assignee) commentParts.push(`Assignee: @${assignee}`);
      if (migrated.branch) commentParts.push(`Branch: \`${migrated.branch}\``);
      if (migrated.commitSha) {
        commentParts.push(`Commit: \`${migrated.commitSha.slice(0, 12)}\``);
      }
      if (migrated.summary?.trim()) {
        commentParts.push(`\n### Summary\n${migrated.summary.trim()}`);
      }
      await commentOnIssue(
        created.projectId,
        created.iid,
        commentParts.join("\n"),
      ).catch((err) => {
        logger.warn("Post-create issue comment failed", {
          err: String(err),
          iid: created.iid,
        });
      });

      return c.json({
        job: migrated,
        issueUrl: created.webUrl,
        assignee: created.assignees[0] || assignee || null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("create-issue failed", { jobId: loaded.id, err: msg });
      return c.json({ error: msg }, 500);
    }
  });

  api.put("/jobs/:id/dev-notes", async (c) => {
    const job = await loadJob(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      devNotes?: string;
      requireDocsFirst?: boolean;
    };
    if (body.devNotes !== undefined) {
      job.devNotes = body.devNotes.trim() || undefined;
    }
    if (body.requireDocsFirst !== undefined) {
      job.requireDocsFirst = Boolean(body.requireDocsFirst);
    }
    await saveJob(job);
    return c.json({ job });
  });

  /** Feature docs (.md/.mdc) for PM review while awaiting_docs_approval */
  api.get("/jobs/:id/docs", async (c) => {
    const job = await loadJob(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    const { readRepoDocs } = await import("../docs/analysis.js");
    const { resolveRepoPath } = await import("../workspace/creds.js");
    const paths =
      job.docsPaths?.length
        ? job.docsPaths
        : job.docsPath
          ? [job.docsPath]
          : [];
    const files = paths.length
      ? await readRepoDocs(resolveRepoPath(), paths)
      : [];
    return c.json({
      jobId: job.id,
      status: job.status,
      requireDocsFirst: Boolean(job.requireDocsFirst),
      docsSummary: job.docsSummary ?? null,
      docsApprovedAt: job.docsApprovedAt ?? null,
      paths,
      files,
    });
  });

  /** PM approves feature docs → enqueue code phase */
  api.post("/jobs/:id/approve-docs", async (c) => {
    const job = await loadJob(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    if (job.status !== "awaiting_docs_approval") {
      return c.json(
        { error: "Approve docs only when status is awaiting_docs_approval" },
        409,
      );
    }
    const result = await jobQueue.enqueueCodeAfterDocsApproval(job.id);
    if (!result.enqueued) {
      return c.json({ error: result.reason ?? "Could not enqueue" }, 409);
    }
    const updated = await loadJob(job.id);
    return c.json({ ok: true, job: updated, jobId: result.jobId });
  });

  /** Re-run docs phase only (from awaiting_docs_approval or with flag) */
  api.post("/jobs/:id/rerun-docs", async (c) => {
    const job = await loadJob(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    if (isJobBusy(job.status)) {
      return c.json({ error: "Job is busy" }, 409);
    }
    job.requireDocsFirst = true;
    job.docsApprovedAt = undefined;
    await saveJob(job);
    const result = await jobQueue.enqueue(job.issue, {
      source: "ui_rerun_docs",
      completion: job.completion,
      devNotes: resolveDevNotes(job) || undefined,
      requireDocsFirst: true,
      forceCodePhase: false,
    });
    if (!result.enqueued) {
      return c.json({ error: result.reason ?? "Could not enqueue" }, 409);
    }
    return c.json({ ok: true, jobId: result.jobId });
  });

  api.get("/jobs/by-issue/:iid", async (c) => {
    const iid = Number(c.req.param("iid"));
    if (!Number.isFinite(iid) || iid <= 0) {
      return c.json({ error: "invalid iid" }, 400);
    }
    const all = await listAssignedOpenIssues();
    const issue = all.find((i) => i.issueIid === iid);
    if (issue) {
      const job = await loadJobByIssue(issue.projectId, iid);
      return c.json({ job });
    }
    const fallback = (await listJobs()).find((j) => j.issue.issueIid === iid);
    return c.json({ job: fallback ?? null });
  });

  api.get("/meta/completion-defaults", async (c) => {
    const config = getConfig();
    return c.json({
      assignees: config.onCompleteAssignUsernames,
      labels: config.onCompleteLabels,
      comment: config.ON_COMPLETE_COMMENT ?? "",
    });
  });

  api.get("/meta/members", async (c) => {
    const { listProjectMembers } = await import("../gitlab/client.js");
    const members = await listProjectMembers();
    return c.json({ members });
  });

  api.get("/meta/labels", async (c) => {
    const { listProjectLabels } = await import("../gitlab/client.js");
    const labels = await listProjectLabels();
    return c.json({ labels });
  });

  api.post("/jobs/:id/completion-actions", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      assignees?: string[];
      labels?: string[];
      removeLabels?: string[];
      labelMode?: "add" | "set";
      comment?: string;
    };
    if (job.status !== "awaiting_handoff" && job.status !== "succeeded") {
      return c.json(
        { error: "Handoff only for awaiting_handoff (or succeeded retry)" },
        409,
      );
    }
    const assignees = (body.assignees ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const labels = (body.labels ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const removeLabels = (body.removeLabels ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const comment = body.comment?.trim();
    if (
      !assignees.length &&
      !labels.length &&
      !removeLabels.length &&
      !comment &&
      body.labelMode !== "set"
    ) {
      return c.json(
        { error: "Need assignees, labels, removeLabels, or comment" },
        400,
      );
    }

    const { applyIssueActions } = await import("../gitlab/client.js");
    const { resolveProcessingLabel } = await import(
      "../gitlab/processing-label.js"
    );
    const proc = resolveProcessingLabel(job.completion?.processingLabel);
    const removeWithProcessing = [
      ...new Set(
        [...removeLabels, proc].map((s) => s.trim()).filter(Boolean),
      ),
    ];
    await applyIssueActions({
      projectId: job.issue.projectId,
      issueIid: job.issue.issueIid,
      assignees,
      labels,
      removeLabels: removeWithProcessing,
      labelMode: body.labelMode === "set" ? "set" : "add",
      comment,
    });

    job.status = "succeeded";
    job.handedOffAt = new Date().toISOString();
    job.error = undefined;
    await saveJob(job);
    return c.json({ ok: true, job });
  });

  /**
   * Merge job work branch into project/base branch, then push target to origin.
   * On conflict → Cursor agent resolves markers, then finalize merge commit.
   */
  api.post("/jobs/:id/merge", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    if (job.status !== "awaiting_handoff" && job.status !== "succeeded") {
      return c.json(
        { error: "Merge only for awaiting_handoff or succeeded jobs" },
        409,
      );
    }
    const source = (job.branch || job.workBranch || "").trim();
    if (!source) {
      return c.json({ error: "Job has no work branch to merge" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      targetBranch?: string;
    };
    const { resolveRepoPath } = await import("../workspace/creds.js");
    const { getRuntimeContext } = await import("../workspace/runtime.js");
    const {
      attemptMergeIntoBase,
      abortMerge,
      finalizeMergeCommit,
      listConflictedFiles,
      tryCheckoutBranch,
      restoreWipAfterMerge,
    } = await import("../git/merge.js");
    const { pushBranch } = await import("../git/prep.js");
    const { resolveMergeConflictsWithAi } = await import(
      "../agent/merge-resolve.js"
    );

    const rt = getRuntimeContext();
    const repoPath = resolveRepoPath();
    const targetHint =
      body.targetBranch?.trim() ||
      job.baseBranch?.trim() ||
      rt?.baseBranch?.trim() ||
      undefined;

    job.mergeError = undefined;
    job.mergePushError = undefined;
    await saveJob(job);

    let previousBranch: string | null | undefined;
    let wipStashMarker: string | null | undefined;
    let wipWarning: string | undefined;

    const finishRestore = async (restoreTo?: string | null) => {
      const branch = restoreTo || previousBranch || source;
      if (branch) await tryCheckoutBranch(repoPath, branch);
      const wip = await restoreWipAfterMerge(repoPath, wipStashMarker);
      if (wip.warning) wipWarning = wip.warning;
      wipStashMarker = null; // avoid double-pop
      return wip;
    };

    try {
      let result = await attemptMergeIntoBase({
        repoPath,
        sourceBranch: source,
        targetBranch: targetHint,
      });
      previousBranch = result.previousBranch;
      wipStashMarker = result.wipStashMarker;

      let aiResolved = false;
      let aiSummary: string | undefined;

      if (result.status === "conflict") {
        const resolved = await resolveMergeConflictsWithAi({
          sourceBranch: result.sourceBranch,
          targetBranch: result.targetBranch,
          conflictedFiles: result.conflictedFiles,
          issue: job.issue,
        });
        aiSummary = resolved.text;
        if (resolved.remaining.length) {
          const again = await resolveMergeConflictsWithAi({
            sourceBranch: result.sourceBranch,
            targetBranch: result.targetBranch,
            conflictedFiles: resolved.remaining,
            issue: job.issue,
          });
          aiSummary = `${aiSummary}\n---\n${again.text}`;
          if (again.remaining.length) {
            const left = again.remaining;
            await abortMerge(repoPath).catch(() => undefined);
            await finishRestore(previousBranch || result.sourceBranch);
            job.mergeError = `AI could not clear conflicts: ${left.join(", ")}`;
            await saveJob(job);
            return c.json(
              {
                error: job.mergeError,
                conflictedFiles: left,
                aiSummary,
                wipWarning,
              },
              409,
            );
          }
        }
        const stillUnmerged = await listConflictedFiles(repoPath);
        if (stillUnmerged.length) {
          await abortMerge(repoPath).catch(() => undefined);
          await finishRestore(previousBranch || result.sourceBranch);
          job.mergeError = `Still unmerged: ${stillUnmerged.join(", ")}`;
          await saveJob(job);
          return c.json(
            { error: job.mergeError, conflictedFiles: stillUnmerged, wipWarning },
            409,
          );
        }

        const sha = await finalizeMergeCommit(
          repoPath,
          `Merge branch '${result.sourceBranch}' into ${result.targetBranch} (AI conflict resolve)`,
        );
        aiResolved = true;
        result = {
          status: "merged",
          targetBranch: result.targetBranch,
          sourceBranch: result.sourceBranch,
          commitSha: sha,
          previousBranch,
          wipStashMarker,
        };
      }

      // Push target while still on merge commit (before restoring work branch / WIP)
      let pushed = false;
      let pushError: string | undefined;
      try {
        await pushBranch(repoPath, result.targetBranch);
        pushed = true;
        logger.info("Pushed merge target to origin", {
          jobId: job.id,
          target: result.targetBranch,
          sha: result.commitSha,
        });
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
        logger.warn("Merge ok but push failed", {
          jobId: job.id,
          target: result.targetBranch,
          err: pushError,
        });
      }

      const restoreTo = result.sourceBranch || previousBranch || undefined;
      await finishRestore(restoreTo);

      job.mergedAt = new Date().toISOString();
      job.mergeTarget = result.targetBranch;
      job.mergeSource = result.sourceBranch;
      job.mergeSha = result.commitSha ?? undefined;
      job.mergeAiResolved = aiResolved;
      job.mergeError = undefined;
      if (pushed) {
        job.mergePushedAt = new Date().toISOString();
        job.mergePushError = undefined;
      } else {
        job.mergePushError = pushError || "push failed";
      }
      if (result.commitSha) {
        job.commitSha = result.commitSha;
        job.commitShas = [...(job.commitShas ?? []), result.commitSha].slice(
          -20,
        );
      }
      await saveJob(job);

      logger.info("Job branch merged into base", {
        jobId: job.id,
        source: result.sourceBranch,
        target: result.targetBranch,
        sha: result.commitSha,
        aiResolved,
        pushed,
        restoredBranch: restoreTo ?? null,
        wipWarning,
      });

      if (!pushed) {
        return c.json(
          {
            error: `Merged local ${result.sourceBranch} → ${result.targetBranch} nhưng push origin thất bại: ${pushError}`,
            job,
            merge: {
              source: result.sourceBranch,
              target: result.targetBranch,
              commitSha: result.commitSha,
              alreadyUpToDate: result.alreadyUpToDate ?? false,
              aiResolved,
              aiSummary,
              pushed: false,
              pushError,
              restoredBranch: restoreTo ?? null,
              wipWarning: wipWarning ?? null,
            },
          },
          502,
        );
      }

      return c.json({
        ok: true,
        job,
        merge: {
          source: result.sourceBranch,
          target: result.targetBranch,
          commitSha: result.commitSha,
          alreadyUpToDate: result.alreadyUpToDate ?? false,
          aiResolved,
          aiSummary,
          pushed: true,
          restoredBranch: restoreTo ?? null,
          wipWarning: wipWarning ?? null,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await abortMerge(repoPath);
      } catch {
        /* */
      }
      await finishRestore(previousBranch || source).catch(() => undefined);
      job.mergeError = msg;
      await saveJob(job);
      logger.warn("Merge failed", { jobId: job.id, err: msg, wipWarning });
      return c.json({ error: msg, wipWarning }, 500);
    }
  });

  /** Todolist / stats: only days with tasks, nested month → week → day (Asia/Ho_Chi_Minh). */
  api.get("/stats/daily", async (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? "90")));
    const jobs = await listJobDocs({ limit: 500 });
    const tz = "Asia/Ho_Chi_Minh";
    const dayKey = (iso?: string) => {
      if (!iso) return null;
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(iso));
      } catch {
        return iso.slice(0, 10);
      }
    };

    const formatYmdUtc = (d: Date) => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };

    /** ISO week from a civil YYYY-MM-DD (calendar day in tz). */
    const isoWeekFromYmd = (ymd: string) => {
      const [Y, M, D] = ymd.split("-").map(Number);
      const utc = new Date(Date.UTC(Y, M - 1, D));
      const dayNum = utc.getUTCDay() || 7; // Mon=1 … Sun=7
      const thursday = new Date(utc);
      thursday.setUTCDate(utc.getUTCDate() + 4 - dayNum);
      const isoYear = thursday.getUTCFullYear();
      const yearStart = new Date(Date.UTC(isoYear, 0, 1));
      const week = Math.ceil(
        ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
      );
      const weekStart = new Date(utc);
      weekStart.setUTCDate(utc.getUTCDate() - (dayNum - 1));
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
      const weekKey = `${isoYear}-W${String(week).padStart(2, "0")}`;
      const ws = formatYmdUtc(weekStart);
      const we = formatYmdUtc(weekEnd);
      return {
        weekKey,
        week,
        isoYear,
        weekStart: ws,
        weekEnd: we,
        weekLabel: `Tuần ${week} · ${ws.slice(5).replace("-", "/")}–${we.slice(5).replace("-", "/")}`,
      };
    };

    const monthLabel = (ym: string) => {
      const [y, m] = ym.split("-").map(Number);
      return `Tháng ${m}/${y}`;
    };

    type DayItem = {
      jobId: string;
      status: string;
      issueIid: number;
      title: string;
      url: string;
      at: string;
      summary?: string;
    };
    type DayBucket = {
      date: string;
      awaitingHandoff: number;
      succeeded: number;
      failed: number;
      runningLike: number;
      items: DayItem[];
    };
    const byDay = new Map<string, DayBucket>();

    const ensure = (d: string): DayBucket => {
      let b = byDay.get(d);
      if (!b) {
        b = {
          date: d,
          awaitingHandoff: 0,
          succeeded: 0,
          failed: 0,
          runningLike: 0,
          items: [],
        };
        byDay.set(d, b);
      }
      return b;
    };

    const windowStart = new Date();
    windowStart.setTime(windowStart.getTime() - (days - 1) * 86400000);
    const windowStartKey = dayKey(windowStart.toISOString())!;

    for (const job of jobs) {
      const at =
        job.completedAt ||
        job.handedOffAt ||
        job.updatedAt ||
        job.createdAt;
      const key = dayKey(at);
      if (!key || key < windowStartKey) continue;

      const bucket = ensure(key);
      if (job.status === "awaiting_handoff") bucket.awaitingHandoff += 1;
      else if (job.status === "succeeded") bucket.succeeded += 1;
      else if (job.status === "failed") bucket.failed += 1;
      else if (
        job.status === "queued" ||
        job.status === "running" ||
        job.status === "awaiting_clarification" ||
        job.status === "draft"
      ) {
        bucket.runningLike += 1;
      }

      if (
        job.status === "awaiting_handoff" ||
        job.status === "succeeded" ||
        job.status === "failed"
      ) {
        bucket.items.push({
          jobId: job.id,
          status: job.status,
          issueIid: job.issue.issueIid,
          title: job.issue.title,
          url: job.issue.url,
          at,
          summary: job.summary,
        });
      }
    }

    // Only days that have todolist items (handoff / done / fail)
    const daily = [...byDay.values()]
      .filter((b) => b.items.length > 0)
      .map((b) => {
        b.items.sort((a, c) => (a.at < c.at ? 1 : -1));
        return b;
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    type WeekNode = {
      weekKey: string;
      label: string;
      weekStart: string;
      weekEnd: string;
      awaitingHandoff: number;
      succeeded: number;
      failed: number;
      days: DayBucket[];
    };
    type MonthNode = {
      monthKey: string;
      label: string;
      awaitingHandoff: number;
      succeeded: number;
      failed: number;
      weeks: WeekNode[];
    };

    const monthMap = new Map<string, MonthNode>();
    for (const day of daily) {
      const monthKey = day.date.slice(0, 7);
      const week = isoWeekFromYmd(day.date);
      let month = monthMap.get(monthKey);
      if (!month) {
        month = {
          monthKey,
          label: monthLabel(monthKey),
          awaitingHandoff: 0,
          succeeded: 0,
          failed: 0,
          weeks: [],
        };
        monthMap.set(monthKey, month);
      }
      let weekNode = month.weeks.find((w) => w.weekKey === week.weekKey);
      if (!weekNode) {
        weekNode = {
          weekKey: week.weekKey,
          label: week.weekLabel,
          weekStart: week.weekStart,
          weekEnd: week.weekEnd,
          awaitingHandoff: 0,
          succeeded: 0,
          failed: 0,
          days: [],
        };
        month.weeks.push(weekNode);
      }
      weekNode.days.push(day);
      weekNode.awaitingHandoff += day.awaitingHandoff;
      weekNode.succeeded += day.succeeded;
      weekNode.failed += day.failed;
      month.awaitingHandoff += day.awaitingHandoff;
      month.succeeded += day.succeeded;
      month.failed += day.failed;
    }

    const months = [...monthMap.values()]
      .map((m) => {
        m.weeks.sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
        for (const w of m.weeks) {
          w.days.sort((a, b) => (a.date < b.date ? 1 : -1));
        }
        return m;
      })
      .sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1));

    const pendingHandoff = jobs.filter((j) => j.status === "awaiting_handoff");

    return c.json({
      timezone: tz,
      days,
      pendingHandoffCount: pendingHandoff.length,
      pendingHandoff: pendingHandoff.map((j) => ({
        jobId: j.id,
        issueIid: j.issue.issueIid,
        title: j.issue.title,
        url: j.issue.url,
        branch: j.branch,
        completedAt: j.completedAt,
        summary: j.summary,
      })),
      /** Flat list — only days with tasks */
      daily,
      /** Nested: month → week → day */
      months,
    });
  });

  /** Apply assign / labels / comment to selected GitLab issues right now */
  api.post("/tasks/update", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      issueIids?: number[];
      assignees?: string[];
      labels?: string[];
      removeLabels?: string[];
      labelMode?: "add" | "set";
      comment?: string;
    };
    const issueIids = (body.issueIids ?? [])
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (issueIids.length === 0) {
      return c.json({ error: "issueIids required" }, 400);
    }
    const assignees = (body.assignees ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const labels = (body.labels ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const removeLabels = (body.removeLabels ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const comment = body.comment?.trim();
    if (
      !assignees.length &&
      !labels.length &&
      !removeLabels.length &&
      !comment &&
      body.labelMode !== "set"
    ) {
      return c.json(
        { error: "Need at least assignees, labels, removeLabels, or comment" },
        400,
      );
    }

    const config = getConfig();
    const { applyIssueActions } = await import("../gitlab/client.js");
    const { resolveGitlabProjectPath } = await import("../workspace/creds.js");
    const assigned = await listAssignedOpenIssues();
    const byIid = new Map(assigned.map((i) => [i.issueIid, i]));
    const results: Array<{ issueIid: number; ok: boolean; error?: string }> =
      [];

    for (const iid of issueIids) {
      try {
        const issue = byIid.get(iid);
        await applyIssueActions({
          projectId: issue?.projectId ?? resolveGitlabProjectPath(),
          issueIid: iid,
          assignees,
          labels,
          removeLabels,
          labelMode: body.labelMode ?? "add",
          comment,
        });
        results.push({ issueIid: iid, ok: true });
      } catch (err) {
        results.push({
          issueIid: iid,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({
      ok: results.every((r) => r.ok),
      results,
    });
  });

  api.get("/jobs", async (c) => {
    const status = c.req.query("status") as
      | "queued"
      | "running"
      | "awaiting_clarification"
      | "awaiting_docs_approval"
      | "awaiting_diff_approval"
      | "awaiting_handoff"
      | "succeeded"
      | "failed"
      | undefined;
    const limit = Number(c.req.query("limit") ?? "50");
    const { getRuntimeContext } = await import("../workspace/runtime.js");
    const rt = getRuntimeContext();
    const jobs = await listJobDocs({
      status,
      limit: Number.isFinite(limit) ? limit : 50,
      workspaceProjectId: rt?.projectId,
      ownerUsername: rt?.gitlabUsername,
    });
    return c.json({
      jobs,
      pendingClarifications: listPendingClarifications(),
      pendingDiffApprovals: listPendingDiffApprovals(),
    });
  });

  api.get("/jobs/:id", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const [notes, chat] = await Promise.all([
      listNotes({ jobId: job.id, limit: 50 }),
      listChatMessages({ jobId: job.id, limit: 200 }),
    ]);
    return c.json({
      job,
      notes,
      chat,
      pendingQuestion:
        job.status === "awaiting_clarification" ? job.lastQuestion : null,
      awaitingDiffApproval:
        job.status === "awaiting_diff_approval" ||
        isAwaitingDiffApproval(job.id),
    });
  });

  api.get("/jobs/:id/progress", async (c) => {
    const jobId = c.req.param("id");
    const job = await getJobDoc(jobId);
    if (!job) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") ?? "0");
    const { lines, latestId } = getJobProgress(
      jobId,
      Number.isFinite(after) ? after : 0,
    );
    const { hasActiveAgentRun } = await import("../agent/run.js");
    const { getJobTokenUsage } = await import("../agent/progress.js");
    const live =
      hasActiveAgentRun(jobId) ||
      ["queued", "running", "awaiting_clarification"].includes(job.status);
    const liveUsage = getJobTokenUsage(jobId);
    const tokenUsage = liveUsage
      ? {
          inputTokens: liveUsage.inputTokens,
          outputTokens: liveUsage.outputTokens,
          totalTokens: liveUsage.totalTokens,
          lastInputTokens: liveUsage.lastInputTokens,
          contextWindow: liveUsage.contextWindow,
          contextPct: liveUsage.contextPct,
          updatedAt: liveUsage.updatedAt,
        }
      : job.tokenUsage ?? null;
    return c.json({
      jobId,
      status: job.status,
      agentId: job.agentId ?? null,
      lines,
      latestId,
      live,
      tokenUsage,
    });
  });

  api.get("/jobs/:id/diff", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const { getRuntimeContext } = await import("../workspace/runtime.js");
    const rt = getRuntimeContext();
    const diff = await getReviewDiff({
      issueIid: job.issue.issueIid,
      branch: job.branch || job.workBranch,
      baseBranch:
        job.baseBranch ||
        rt?.baseBranch ||
        job.mergeTarget ||
        undefined,
      commitSha: job.commitSha,
    });
    const text = [diff.rangeDiff, diff.staged, diff.unstaged]
      .filter(Boolean)
      .join("\n");
    const paths =
      diff.files?.length > 0
        ? diff.files.map((f) => f.path)
        : extractPathsFromUnifiedDiff(text);
    return c.json({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      status: job.status,
      branch: job.branch || null,
      commitSha: job.commitSha || null,
      diff,
      paths,
      files: diff.files,
      awaitingDiffApproval:
        job.status === "awaiting_diff_approval" ||
        isAwaitingDiffApproval(job.id),
    });
  });

  api.post("/jobs/:id/kill", async (c) => {
    const jobId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const result = await jobQueue.killJob(
      jobId,
      body.reason?.trim() || "Force-stopped from UI",
    );
    if (!result.ok) {
      return c.json({ error: "Job not killable", ...result }, 409);
    }
    return c.json(result);
  });

  /** Drop Cursor agent window; next Run/chat creates a fresh one. */
  api.post("/jobs/:id/reset-window", async (c) => {
    const jobId = c.req.param("id");
    try {
      const result = await jobQueue.resetAgentWindow(jobId);
      return c.json({
        ok: result.ok,
        killed: result.killed,
        previousAgentId: result.previousAgentId ?? null,
        job: result.job,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /not found/i.test(msg) ? 404 : 500;
      return c.json({ error: msg }, code);
    }
  });

  /** Manual status override (draft / handoff / done / failed). Busy jobs must be killed first. */
  const MANUAL_STATUSES = new Set<JobStatus>([
    "draft",
    "awaiting_handoff",
    "succeeded",
    "failed",
  ]);

  api.patch("/jobs/:id/status", async (c) => {
    const jobId = c.req.param("id");
    const job = await loadJob(jobId);
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      status?: string;
      force?: boolean;
    };
    const next = body.status as JobStatus | undefined;
    if (!next || !MANUAL_STATUSES.has(next)) {
      return c.json(
        {
          error: "Invalid status",
          allowed: [...MANUAL_STATUSES],
        },
        400,
      );
    }
    if (isJobBusy(job.status)) {
      if (!body.force) {
        return c.json(
          {
            error: "Job is busy — stop it first or pass force: true",
            status: job.status,
          },
          409,
        );
      }
      await jobQueue.killJob(jobId, "Stopped before manual status change");
    }
    job.status = next;
    if (next === "succeeded" || next === "awaiting_handoff") {
      job.error = undefined;
    }
    if (next === "failed" && !job.error) {
      job.error = "Marked failed from UI";
    }
    await saveJob(job, { source: "manual-status" });
    return c.json({ job });
  });

  api.delete("/jobs/:id", async (c) => {
    const jobId = c.req.param("id");
    const job = await loadJob(jobId);
    if (!job) return c.json({ error: "not found" }, 404);
    const force =
      c.req.query("force") === "1" ||
      c.req.query("force") === "true";
    if (isJobBusy(job.status)) {
      if (!force) {
        return c.json(
          {
            error: "Job is busy — stop it first or delete with force=1",
            status: job.status,
          },
          409,
        );
      }
      await jobQueue.killJob(jobId, "Stopped before delete");
    }
    const side = await deleteJobSideDocs(jobId);
    const deleted = await deleteJobDoc(jobId);
    if (!deleted) return c.json({ error: "not found" }, 404);
    const { publishRealtime } = await import("../realtime/hub.js");
    publishRealtime({ type: "jobs", reason: "delete", jobId });
    logger.info("job deleted from UI", { jobId, side });
    return c.json({ ok: true, jobId, ...side });
  });

  api.post("/jobs/:id/approve-diff", async (c) => {
    const jobId = c.req.param("id");
    const job = await getJobDoc(jobId);
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: "approve" | "reject";
      message?: string;
    };
    const action = body.action === "reject" ? "reject" : "approve";
    const ok = submitDiffApproval(
      jobId,
      action === "approve"
        ? { action: "approve" }
        : { action: "reject", message: body.message },
    );
    if (!ok) {
      return c.json(
        { error: "Job is not awaiting diff approval" },
        409,
      );
    }
    return c.json({ ok: true, action });
  });

  api.get("/jobs/:id/file", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    try {
      const content = await readRepoFile(filePath);
      return c.json({ path: filePath, content });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.put("/jobs/:id/file", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    if (
      job.status !== "awaiting_diff_approval" &&
      !isAwaitingDiffApproval(job.id)
    ) {
      return c.json(
        { error: "Inline edit only while awaiting_diff_approval" },
        409,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      path?: string;
      content?: string;
    };
    if (!body.path || body.content === undefined) {
      return c.json({ error: "path and content required" }, 400);
    }
    try {
      await writeRepoFile(body.path, body.content);
      return c.json({ ok: true, path: body.path });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.get("/jobs/:id/linked", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const { collectLinkedIssueContext } = await import(
      "../gitlab/linked-context.js"
    );
    const linked = await collectLinkedIssueContext(job.issue);
    return c.json({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      linked: linked.linked,
      comments: linked.commentExcerpts,
    });
  });

  api.get("/diff", async (c) => {
    const issueIid = c.req.query("issueIid");
    const diff = await getReviewDiff({
      issueIid: issueIid ? Number(issueIid) : undefined,
    });
    return c.json({ diff });
  });

  /** Answer agent clarification from UI (replaces Teams). */
  api.post("/jobs/:id/clarify", async (c) => {
    const jobId = c.req.param("id");
    const job = await getJobDoc(jobId);
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { answer?: string };
    if (!body.answer?.trim()) {
      return c.json({ error: "answer required" }, 400);
    }
    const ok = submitUiClarification(jobId, body.answer);
    if (!ok) {
      return c.json(
        {
          error:
            "No pending clarification waiter for this job (already answered or not waiting)",
        },
        409,
      );
    }
    return c.json({ ok: true });
  });

  /**
   * Cursor-IDE-style chat on the same agent window.
   * Ask / fix / do more after DONE — keeps conversation context.
   */
  api.post("/jobs/:id/continue", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      message?: string;
    };
    if (!body.message?.trim()) {
      return c.json({ error: "message required" }, 400);
    }
    try {
      const result = await jobQueue.followUpChat(job.id, body.message);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("IDE continue failed", { jobId: job.id, err: msg });
      const status =
        /đang chạy|Force Stop|clarify/i.test(msg) ? 409 : 500;
      return c.json({ error: msg }, status);
    }
  });

  /** Freeform Q&A / review-only (optional; prefer /continue for IDE-like chat). */
  api.post("/jobs/:id/ask", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      question?: string;
    };
    if (!body.question?.trim()) {
      return c.json({ error: "question required" }, 400);
    }

    const { hasActiveAgentRun } = await import("../agent/run.js");
    if (hasActiveAgentRun(job.id)) {
      return c.json(
        {
          error:
            "Agent đang chạy trên job này — đợi xong hoặc Force Stop rồi hỏi Q&A lại",
        },
        409,
      );
    }

    const priorChat = await listChatMessages({ jobId: job.id, limit: 40 });

    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "user",
      kind: "qa",
      body: body.question,
    });

    try {
      const qa = await answerTaskQuestion({
        issue: job.issue,
        question: body.question,
        jobId: job.id,
        existingAgentId: job.agentId,
        history: priorChat.map((m) => ({
          role: m.role,
          kind: m.kind,
          body: m.body,
        })),
      });
      job.agentId = qa.agentId;
      if (qa.usage) {
        job.tokenUsage = {
          inputTokens: qa.usage.inputTokens,
          outputTokens: qa.usage.outputTokens,
          totalTokens: qa.usage.totalTokens,
          lastInputTokens: qa.usage.lastInputTokens,
          contextWindow: qa.usage.contextWindow,
          contextPct: qa.usage.contextPct,
          updatedAt: qa.usage.updatedAt,
        };
      }
      await saveJob(job);
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "qa",
        body: qa.answer,
      });
      return c.json({
        answer: qa.answer,
        agentId: qa.agentId,
        resumed: qa.resumed,
        tokenUsage: job.tokenUsage ?? null,
      });
    } catch (err) {
      logger.error("Q&A failed", { err: String(err) });
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "system",
        kind: "qa",
        body: `Q&A lỗi: ${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => undefined);
      return c.json({ error: String(err) }, 500);
    }
  });

  api.get("/jobs/:id/chat", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const chat = await listChatMessages({ jobId: job.id, limit: 200 });
    return c.json({ chat });
  });

  /** Append a user chat line without calling the Q&A agent (e.g. before Bật Run). */
  api.post("/jobs/:id/chat", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      body?: string;
      kind?: "qa" | "clarify" | "note";
    };
    if (!body.body?.trim()) {
      return c.json({ error: "body required" }, 400);
    }
    const kind =
      body.kind === "clarify" || body.kind === "note" ? body.kind : "qa";
    const msg = await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "user",
      kind,
      body: body.body,
    });
    return c.json({ ok: true, message: msg });
  });

  api.post("/jobs/:id/notes", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { body?: string };
    if (!body.body?.trim()) {
      return c.json({ error: "body required" }, 400);
    }
    const note = await addNote({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      projectPath: job.issue.projectPath,
      body: body.body,
    });
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "user",
      kind: "note",
      body: body.body,
    });
    return c.json({ note });
  });

  api.get("/notes", async (c) => {
    const issueIid = c.req.query("issueIid");
    const jobId = c.req.query("jobId") ?? undefined;
    const notes = await listNotes({
      issueIid: issueIid ? Number(issueIid) : undefined,
      jobId,
      limit: 100,
    });
    return c.json({ notes });
  });

  api.post("/notes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      issueIid?: number;
      jobId?: string;
      body?: string;
    };
    if (!body.body?.trim() || body.issueIid === undefined) {
      return c.json({ error: "issueIid and body required" }, 400);
    }
    const { resolveGitlabProjectPath } = await import("../workspace/creds.js");
    const note = await addNote({
      jobId: body.jobId,
      issueIid: Number(body.issueIid),
      projectPath: resolveGitlabProjectPath(),
      body: body.body,
    });
    return c.json({ note });
  });

  return api;
}
