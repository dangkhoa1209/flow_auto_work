import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  addJobNote,
  appendJobChat,
  applyCompletionActions,
  approveJobDiff,
  approveJobDocs,
  askJobQuestion,
  buildIssueDraft,
  continueJobChat,
  createAdhocSession,
  createIssueFromAdhoc,
  deleteJob,
  ensureJobForIssue,
  findJobByIssueIid,
  getJobChat,
  getJobCommits,
  getJobDetail,
  getJobDiff,
  getJobDocsForReview,
  getJobProgressForUi,
  getLinkedIssueContext,
  killJob,
  listJobsForUi,
  mergeJobBranch,
  readJobFile,
  rerunJobDocs,
  resetJobWindow,
  revertJobCommit,
  setJobStatus,
  startJobs,
  updateDevNotes,
  writeJobFile,
  type AdhocJobInput,
  type CompletionActionsInput,
  type CreateIssueFromAdhocInput,
  type DevNotesInput,
  type EnsureJobInput,
  type StartJobsInput,
} from "../../modules/job/index.js";
import type { JobStatus } from "../../types.js";

/** Body is always an object — express.json leaves undefined for empty payloads. */
function body<T>(req: Request): T {
  return (req.body || {}) as T;
}

function jobId(req: Request): string {
  return String(req.params.id ?? "");
}

function queryString(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  return s || undefined;
}

/**
 * Express controllers — extract HTTP input, call modules, write res.
 * No business logic here (queue / GitLab / Mongo stay in modules).
 */
export const jobController = {
  /** GET /api/jobs?limit=&status= */
  list: asyncHandler(async (req: Request, res: Response) => {
    const status = req.query.status as JobStatus | undefined;
    const limit = Number(req.query.limit ?? "50");
    const data = await listJobsForUi({
      status,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    res.json(data);
  }),

  /** POST /api/jobs/start */
  start: asyncHandler(async (req: Request, res: Response) => {
    res.json(await startJobs(body<StartJobsInput>(req)));
  }),

  /** POST /api/jobs/ensure */
  ensure: asyncHandler(async (req: Request, res: Response) => {
    res.json(await ensureJobForIssue(body<EnsureJobInput>(req)));
  }),

  /** POST /api/jobs/adhoc */
  adhoc: asyncHandler(async (req: Request, res: Response) => {
    res.json(await createAdhocSession(body<AdhocJobInput>(req)));
  }),

  /** GET /api/jobs/by-issue/:iid */
  byIssue: asyncHandler(async (req: Request, res: Response) => {
    res.json(await findJobByIssueIid(Number(req.params.iid)));
  }),

  /** GET /api/jobs/:id/issue-draft */
  issueDraft: asyncHandler(async (req: Request, res: Response) => {
    res.json(await buildIssueDraft(jobId(req)));
  }),

  /** POST /api/jobs/:id/create-issue */
  createIssue: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await createIssueFromAdhoc(
        jobId(req),
        body<CreateIssueFromAdhocInput>(req),
      ),
    );
  }),

  /** PUT /api/jobs/:id/dev-notes */
  updateDevNotes: asyncHandler(async (req: Request, res: Response) => {
    res.json(await updateDevNotes(jobId(req), body<DevNotesInput>(req)));
  }),

  /** GET /api/jobs/:id/docs */
  docs: asyncHandler(async (req: Request, res: Response) => {
    res.json(await getJobDocsForReview(jobId(req)));
  }),

  /** POST /api/jobs/:id/approve-docs */
  approveDocs: asyncHandler(async (req: Request, res: Response) => {
    res.json(await approveJobDocs(jobId(req)));
  }),

  /** POST /api/jobs/:id/rerun-docs */
  rerunDocs: asyncHandler(async (req: Request, res: Response) => {
    res.json(await rerunJobDocs(jobId(req)));
  }),

  /** POST /api/jobs/:id/completion-actions */
  completionActions: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await applyCompletionActions(jobId(req), body<CompletionActionsInput>(req)),
    );
  }),

  /** POST /api/jobs/:id/merge */
  merge: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await mergeJobBranch(jobId(req), body<{ targetBranch?: string }>(req)),
    );
  }),

  /** GET /api/jobs/:id */
  detail: asyncHandler(async (req: Request, res: Response) => {
    res.json(await getJobDetail(jobId(req)));
  }),

  /** GET /api/jobs/:id/progress?after= */
  progress: asyncHandler(async (req: Request, res: Response) => {
    const after = Number(req.query.after ?? "0");
    res.json(await getJobProgressForUi(jobId(req), after));
  }),

  /** GET /api/jobs/:id/commits */
  commits: asyncHandler(async (req: Request, res: Response) => {
    res.json(await getJobCommits(jobId(req)));
  }),

  /** POST /api/jobs/:id/commits/:sha/revert */
  revertCommit: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await revertJobCommit(
        jobId(req),
        String(req.params.sha ?? ""),
        body<{ message?: string }>(req),
      ),
    );
  }),

  /** GET /api/jobs/:id/diff?commit=|sha= */
  diff: asyncHandler(async (req: Request, res: Response) => {
    const singleCommit =
      queryString(req.query.commit) ?? queryString(req.query.sha);
    res.json(await getJobDiff(jobId(req), singleCommit));
  }),

  /** POST /api/jobs/:id/kill */
  kill: asyncHandler(async (req: Request, res: Response) => {
    const { reason } = body<{ reason?: string }>(req);
    const result = await killJob(jobId(req), reason);
    if (!result.ok) {
      res.status(409).json({ error: "Job not killable", ...result });
      return;
    }
    res.json(result);
  }),

  /** POST /api/jobs/:id/reset-window */
  resetWindow: asyncHandler(async (req: Request, res: Response) => {
    res.json(await resetJobWindow(jobId(req)));
  }),

  /** PATCH /api/jobs/:id/status */
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    const result = await setJobStatus(
      jobId(req),
      body<{ status?: string; force?: boolean }>(req),
    );
    if (result.ok) {
      res.json({ job: result.job });
      return;
    }
    if (result.reason === "invalid_status") {
      res.status(400).json({ error: "Invalid status", allowed: result.allowed });
      return;
    }
    res.status(409).json({
      error: "Job is busy — stop it first or pass force: true",
      status: result.status,
    });
  }),

  /** DELETE /api/jobs/:id?force=1 */
  remove: asyncHandler(async (req: Request, res: Response) => {
    const force = req.query.force === "1" || req.query.force === "true";
    const result = await deleteJob(jobId(req), force);
    if (!result.ok) {
      res.status(409).json({
        error: "Job is busy — stop it first or delete with force=1",
        status: result.status,
      });
      return;
    }
    res.json(result);
  }),

  /** POST /api/jobs/:id/approve-diff */
  approveDiff: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await approveJobDiff(
        jobId(req),
        body<{ action?: "approve" | "reject"; message?: string }>(req),
      ),
    );
  }),

  /** GET /api/jobs/:id/file?path= */
  readFile: asyncHandler(async (req: Request, res: Response) => {
    res.json(await readJobFile(jobId(req), queryString(req.query.path)));
  }),

  /** PUT /api/jobs/:id/file */
  writeFile: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await writeJobFile(
        jobId(req),
        body<{ path?: string; content?: string }>(req),
      ),
    );
  }),

  /** GET /api/jobs/:id/linked */
  linked: asyncHandler(async (req: Request, res: Response) => {
    res.json(await getLinkedIssueContext(jobId(req)));
  }),

  /** POST /api/jobs/:id/continue */
  continueChat: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await continueJobChat(jobId(req), body<{ message?: string }>(req)),
    );
  }),

  /** POST /api/jobs/:id/ask */
  ask: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await askJobQuestion(jobId(req), body<{ question?: string }>(req)),
    );
  }),

  /** GET /api/jobs/:id/chat */
  chat: asyncHandler(async (req: Request, res: Response) => {
    res.json(await getJobChat(jobId(req)));
  }),

  /** POST /api/jobs/:id/chat */
  appendChat: asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await appendJobChat(
        jobId(req),
        body<{ body?: string; kind?: "qa" | "note" }>(req),
      ),
    );
  }),

  /** POST /api/jobs/:id/notes */
  addNote: asyncHandler(async (req: Request, res: Response) => {
    res.json(await addJobNote(jobId(req), body<{ body?: string }>(req)));
  }),
};
