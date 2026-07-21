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
import {
  addChatMessage,
  addNote,
  getJobDoc,
  listChatMessages,
  listJobDocs,
  listNotes,
  mongoPing,
} from "../db/mongo.js";
import { getReviewDiff } from "../git/diff.js";
import { listAssignedOpenIssues } from "../gitlab/client.js";
import { scanExistingAssignedIssues } from "../gitlab/startup-scan.js";
import { saveJob } from "../job-store.js";
import { logger } from "../logger.js";
import { jobQueue } from "../queue.js";

export function createApiRoutes() {
  const api = new Hono();

  api.get("/status", async (c) => {
    const config = getConfig();
    const mongoOk = await mongoPing();
    return c.json({
      ok: true,
      mongo: mongoOk,
      project: config.ALLOWED_PROJECT_PATH,
      assignee: config.GITLAB_ASSIGNEE_USERNAME,
      queue: jobQueue.snapshot(),
      pendingClarifications: listPendingClarifications(),
    });
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
      issueIids?: number[];
      completion?: {
        assignees?: string[];
        labels?: string[];
        removeLabels?: string[];
        onStartLabels?: string[];
        labelMode?: "add" | "set";
        comment?: string;
      };
    };
    const mode = body.mode === "selected" ? "selected" : "auto";
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
          labelMode:
            body.completion.labelMode === "set"
              ? ("set" as const)
              : ("add" as const),
          comment: body.completion.comment?.trim() || undefined,
        }
      : undefined;

    if (mode === "auto") {
      // Auto scan uses env defaults unless UI sent completion overrides —
      // apply overrides by enqueueing selected-from-scan with completion.
      if (!completion) {
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
        const result = jobQueue.enqueue(issue, {
          source: "ui_auto",
          completion,
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
    if (iids.length === 0) {
      return c.json({ error: "issueIids required for mode=selected" }, 400);
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
      const result = jobQueue.enqueue(issue, {
        source: "ui_selected",
        completion,
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
    await applyIssueActions({
      projectId: job.issue.projectId,
      issueIid: job.issue.issueIid,
      assignees,
      labels,
      removeLabels,
      labelMode: body.labelMode === "set" ? "set" : "add",
      comment,
    });

    job.status = "succeeded";
    job.handedOffAt = new Date().toISOString();
    job.error = undefined;
    await saveJob(job);
    return c.json({ ok: true, job });
  });

  /** Todolist / stats grouped by calendar day (Asia/Ho_Chi_Minh). */
  api.get("/stats/daily", async (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? "14")));
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

    type DayBucket = {
      date: string;
      awaitingHandoff: number;
      succeeded: number;
      failed: number;
      runningLike: number;
      items: Array<{
        jobId: string;
        status: string;
        issueIid: number;
        title: string;
        url: string;
        at: string;
        summary?: string;
      }>;
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

    // Fill empty days for the window
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = dayKey(d.toISOString())!;
      ensure(key);
    }

    for (const job of jobs) {
      const at =
        job.completedAt ||
        job.handedOffAt ||
        job.updatedAt ||
        job.createdAt;
      const key = dayKey(at);
      if (!key) continue;
      // Only include if within window (bucket exists) or create for older
      const bucket = byDay.has(key) ? byDay.get(key)! : ensure(key);
      if (job.status === "awaiting_handoff") bucket.awaitingHandoff += 1;
      else if (job.status === "succeeded") bucket.succeeded += 1;
      else if (job.status === "failed") bucket.failed += 1;
      else if (
        job.status === "queued" ||
        job.status === "running" ||
        job.status === "awaiting_clarification"
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

    for (const b of byDay.values()) {
      b.items.sort((a, c) => (a.at < c.at ? 1 : -1));
    }

    const daily = [...byDay.values()].sort((a, b) =>
      a.date < b.date ? 1 : -1,
    );

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
      daily,
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
    const assigned = await listAssignedOpenIssues();
    const byIid = new Map(assigned.map((i) => [i.issueIid, i]));
    const results: Array<{ issueIid: number; ok: boolean; error?: string }> =
      [];

    for (const iid of issueIids) {
      try {
        const issue = byIid.get(iid);
        await applyIssueActions({
          projectId: issue?.projectId ?? config.ALLOWED_PROJECT_PATH,
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
      | "awaiting_diff_approval"
      | "awaiting_handoff"
      | "succeeded"
      | "failed"
      | undefined;
    const limit = Number(c.req.query("limit") ?? "50");
    const jobs = await listJobDocs({
      status,
      limit: Number.isFinite(limit) ? limit : 50,
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
    return c.json({
      jobId,
      status: job.status,
      lines,
      latestId,
      live: ["queued", "running", "awaiting_clarification"].includes(job.status),
    });
  });

  api.get("/jobs/:id/diff", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const diff = await getReviewDiff({ issueIid: job.issue.issueIid });
    const text = [
      diff.rangeDiff,
      diff.staged,
      diff.unstaged,
    ]
      .filter(Boolean)
      .join("\n");
    const paths = extractPathsFromUnifiedDiff(text);
    return c.json({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      diff,
      paths,
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

  /** Freeform Q&A / review questions about the task + diff. */
  api.post("/jobs/:id/ask", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      question?: string;
    };
    if (!body.question?.trim()) {
      return c.json({ error: "question required" }, 400);
    }

    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "user",
      kind: "qa",
      body: body.question,
    });

    try {
      const answer = await answerTaskQuestion({
        issue: job.issue,
        question: body.question,
      });
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "qa",
        body: answer,
      });
      return c.json({ answer });
    } catch (err) {
      logger.error("Q&A failed", { err: String(err) });
      return c.json({ error: String(err) }, 500);
    }
  });

  api.get("/jobs/:id/chat", async (c) => {
    const job = await getJobDoc(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const chat = await listChatMessages({ jobId: job.id, limit: 200 });
    return c.json({ chat });
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
    const note = await addNote({
      jobId: body.jobId,
      issueIid: Number(body.issueIid),
      projectPath: getConfig().ALLOWED_PROJECT_PATH,
      body: body.body,
    });
    return c.json({ note });
  });

  return api;
}
