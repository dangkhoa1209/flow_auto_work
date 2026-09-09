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
  getSyncDbQueueSnapshot,
  listSyncDbs,
  readSyncDbLog,
  subscribeSyncDbEvents,
  triggerSyncDb,
} from "../../modules/syncDb/index.js";

function username(): string {
  return requireRoleContext().username;
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
    const projectId = String(req.query.projectId || "").trim();
    if (!projectId) {
      throw new AppError("projectId required", 400);
    }
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
    const projectId = String(req.query.projectId || "").trim() || undefined;
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
    res.formatter.ok({ job: await getSyncDb(String(req.params.id || "")) });
  }),

  trigger: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { projectId?: string };
    const projectId = String(body.projectId || req.params.projectId || "").trim();
    if (!projectId) {
      throw new AppError("projectId required", 400);
    }
    const job = await triggerSyncDb({
      projectId,
      triggeredBy: username(),
    });
    res.formatter.accepted({ job, queue: getSyncDbQueueSnapshot() });
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const job = await cancelSyncDb(
      String(req.params.id || ""),
      "Cancelled from BA Chat",
    );
    res.formatter.ok({ job, queue: getSyncDbQueueSnapshot() });
  }),

  log: asyncHandler(async (req: Request, res: Response) => {
    const { job, text, lines } = await readSyncDbLog(
      String(req.params.id || ""),
    );
    res.formatter.ok({ job, text, lines });
  }),

  events: asyncHandler(async (req: Request, res: Response) => {
    const client = setupSse(req, res, { heartbeatMs: 15_000 });
    client.send("queue", { type: "queue", snapshot: getSyncDbQueueSnapshot() });
    client.send("hello", { ok: true, at: new Date().toISOString() });

    const unsub = subscribeSyncDbEvents((ev) => {
      if (client.closed) {
        unsub();
        return;
      }
      // events channel: queue + job + progress + done (no high-volume logs)
      if (ev.type === "log") return;
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

  stream: asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const { job, lines } = await readSyncDbLog(id);
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
