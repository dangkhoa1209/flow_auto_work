import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { setupSse } from "../sseHelper.js";
import { requireRoleContext } from "../middleware/roleAuth.js";
import {
  SYNC_DB_STATUSES,
  type SyncDbStatus,
} from "../../modules/syncDb/types.js";
import {
  adminGetSyncDbConfig,
  adminUpdateSyncDbConfig,
  cancelSyncDb,
  countSyncDbs,
  getSyncDb,
  getSyncDbCapability,
  getSyncDbJob,
  getSyncDbQueueSnapshot,
  listSyncDbs,
  readSyncDbLog,
  subscribeSyncDbEvents,
  triggerSyncDb,
} from "../../modules/syncDb/index.js";

function username(): string {
  return requireRoleContext().username;
}

function requireProjectId(raw: unknown): string {
  const projectId = String(raw || "").trim();
  if (!projectId) {
    throw new AppError("projectId required", 400, "sync_db_project_required");
  }
  return projectId;
}

function asStatus(raw: unknown): SyncDbStatus | undefined {
  const s = String(raw || "").trim();
  if (!s) return undefined;
  if ((SYNC_DB_STATUSES as readonly string[]).includes(s)) {
    return s as SyncDbStatus;
  }
  throw new AppError("Invalid status filter", 400, "invalid_status");
}

export const syncDbController = {
  capability: asyncHandler(async (req: Request, res: Response) => {
    const projectId = requireProjectId(req.query.projectId);
    res.formatter.ok({
      capability: await getSyncDbCapability(projectId),
      queue: getSyncDbQueueSnapshot(),
    });
  }),

  queue: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(getSyncDbQueueSnapshot());
  }),

  listJobs: asyncHandler(async (req: Request, res: Response) => {
    const limit = Number(req.query.limit || 40);
    const offset = Number(req.query.offset || 0);
    const status = asStatus(req.query.status);
    const projectId = requireProjectId(req.query.projectId);
    const [jobs, total] = await Promise.all([
      listSyncDbs({
        limit: Number.isFinite(limit) ? limit : 40,
        offset: Number.isFinite(offset) ? offset : 0,
        status,
        projectId,
      }),
      countSyncDbs({ status, projectId }),
    ]);
    res.formatter.ok({ queue: getSyncDbQueueSnapshot(), jobs, total });
  }),

  getJob: asyncHandler(async (req: Request, res: Response) => {
    const projectId = requireProjectId(req.query.projectId);
    res.formatter.ok({
      job: await getSyncDb(String(req.params.id || ""), { projectId }),
    });
  }),

  trigger: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { projectId?: string };
    const projectId = requireProjectId(
      body.projectId || req.params.projectId,
    );
    const job = await triggerSyncDb({
      projectId,
      triggeredBy: username(),
    });
    res.formatter.accepted({ job, queue: getSyncDbQueueSnapshot() });
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { projectId?: string };
    const projectId = requireProjectId(
      body.projectId || req.query.projectId,
    );
    const job = await cancelSyncDb(
      String(req.params.id || ""),
      "Cancelled from BA Chat",
      { projectId },
    );
    res.formatter.ok({ job, queue: getSyncDbQueueSnapshot() });
  }),

  log: asyncHandler(async (req: Request, res: Response) => {
    const projectId = requireProjectId(req.query.projectId);
    const { job, text, lines } = await readSyncDbLog(
      String(req.params.id || ""),
      { projectId },
    );
    res.formatter.ok({ job, text, lines });
  }),

  events: asyncHandler(async (req: Request, res: Response) => {
    const projectId = requireProjectId(req.query.projectId);
    const client = setupSse(req, res, { heartbeatMs: 15_000 });
    client.send("queue", { type: "queue", snapshot: getSyncDbQueueSnapshot() });
    client.send("hello", {
      ok: true,
      projectId,
      at: new Date().toISOString(),
    });

    // jobId → projectId for filtering progress without leaking other projects
    const jobProject = new Map<string, string>();
    const snap = getSyncDbQueueSnapshot();
    if (snap.currentJobId) {
      const cur = await getSyncDbJob(snap.currentJobId);
      if (cur) jobProject.set(cur.id, cur.projectId);
    }

    const resolveOwner = async (jobId: string): Promise<string | null> => {
      const cached = jobProject.get(jobId);
      if (cached) return cached;
      const job = await getSyncDbJob(jobId);
      if (!job) return null;
      jobProject.set(job.id, job.projectId);
      return job.projectId;
    };

    const unsub = subscribeSyncDbEvents((ev) => {
      if (client.closed) {
        unsub();
        return;
      }
      if (ev.type === "log") return;

      if (ev.type === "queue") {
        if (!client.send(ev.type, ev)) unsub();
        return;
      }

      if (ev.type === "job" || ev.type === "done") {
        jobProject.set(ev.job.id, ev.job.projectId);
        if (ev.job.projectId !== projectId) return;
        if (!client.send(ev.type, ev)) unsub();
        return;
      }

      if (ev.type === "progress") {
        void resolveOwner(ev.jobId).then((owner) => {
          if (client.closed) return;
          if (owner !== projectId) return;
          if (!client.send(ev.type, ev)) unsub();
        });
        return;
      }
    });

    await new Promise<void>((resolve) => {
      const done = () => {
        unsub();
        client.close();
        resolve();
      };
      req.on("close", done);
      res.on("close", done);
    });
  }),

  stream: asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const projectId = requireProjectId(req.query.projectId);
    const { job, lines } = await readSyncDbLog(id, { projectId });
    const client = setupSse(req, res, { heartbeatMs: 15_000 });
    client.send("job", { type: "job", job });
    client.send("progress", {
      type: "progress",
      jobId: id,
      progress: job.progress,
    });
    for (const line of lines) {
      if (
        !client.send("log", {
          type: "log",
          jobId: id,
          at: line.at,
          stream: line.stream,
          text: line.text,
        })
      ) {
        client.close();
        return;
      }
    }
    if (job.status !== "queued" && job.status !== "running") {
      client.send("done", { type: "done", jobId: id, job });
    }

    const unsub = subscribeSyncDbEvents((ev) => {
      if (client.closed) {
        unsub();
        return;
      }
      if (ev.type === "log" && ev.jobId !== id) return;
      if (ev.type === "job" && ev.job.id !== id) return;
      if (ev.type === "progress" && ev.jobId !== id) return;
      if (ev.type === "done" && ev.jobId !== id) return;
      if (ev.type === "queue") return;
      if (!client.send(ev.type, ev)) unsub();
    });

    await new Promise<void>((resolve) => {
      const done = () => {
        unsub();
        client.close();
        resolve();
      };
      req.on("close", done);
      res.on("close", done);
    });
  }),

  adminGetConfig: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok({ config: await adminGetSyncDbConfig() });
  }),

  adminPutConfig: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Guard: empty PUT used to wipe config when the client sent Axios `body`
    // instead of `data` (ignored → `{}`).
    if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
      throw new AppError(
        "Empty Sync DB settings body — nothing to save",
        400,
        "sync_db_empty_body",
      );
    }
    const config = await adminUpdateSyncDbConfig(
      {
        enabled: body.enabled as boolean | undefined,
        sshHost: body.sshHost as string | undefined,
        sshPort: body.sshPort as number | undefined,
        sshUsername: body.sshUsername as string | undefined,
        sshPassword: body.sshPassword as string | undefined,
        sshPrivateKey: body.sshPrivateKey as string | undefined,
        clearSshPassword: Boolean(body.clearSshPassword),
        clearSshPrivateKey: Boolean(body.clearSshPrivateKey),
        tunnelLocalPort: body.tunnelLocalPort as number | undefined,
        remoteMongoHost: body.remoteMongoHost as string | undefined,
        remoteMongoPort: body.remoteMongoPort as number | undefined,
        sourceUsername: body.sourceUsername as string | undefined,
        sourcePassword: body.sourcePassword as string | undefined,
        clearSourcePassword: Boolean(body.clearSourcePassword),
        sourceAuthSource: body.sourceAuthSource as string | undefined,
        dropTarget: body.dropTarget as boolean | undefined,
        timeoutSec: body.timeoutSec as number | undefined,
      },
      username(),
    );
    res.formatter.ok({ config });
  }),
};
