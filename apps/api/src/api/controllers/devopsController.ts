import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { setupSse } from "../sseHelper.js";
import { requireDevopsContext } from "../middleware/devopsAuth.js";
import {
  BUILD_STATUSES,
  type BuildStatus,
} from "../../modules/devops/types.js";
import {
  addBuildScript,
  cancelBuild,
  countBuilds,
  getBuild,
  getBuildQueueSnapshot,
  listBuildScripts,
  listBuilds,
  patchBuildScript,
  readBuildLog,
  removeBuildScript,
  sendBuildStdin,
  subscribeBuildEvents,
  triggerBuild,
} from "../../modules/devops/index.js";

function username(): string {
  return requireDevopsContext().username;
}

function asStatus(raw: unknown): BuildStatus | undefined {
  const s = String(raw || "").trim();
  if (!s) return undefined;
  if ((BUILD_STATUSES as readonly string[]).includes(s)) {
    return s as BuildStatus;
  }
  throw new AppError("Invalid status filter", 400, "invalid_status");
}

export const devopsController = {
  listScripts: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok({ scripts: await listBuildScripts() });
  }),

  createScript: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      id?: string;
      label?: string;
      command?: string;
      workingDir?: string;
      timeoutSec?: number;
      description?: string;
      active?: boolean;
    };
    const script = await addBuildScript(body, username());
    res.formatter.created({ script });
  }),

  updateScript: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      label?: string;
      command?: string;
      workingDir?: string;
      timeoutSec?: number;
      description?: string;
      active?: boolean;
    };
    const script = await patchBuildScript(
      String(req.params.scriptId || ""),
      body,
    );
    res.formatter.ok({ script });
  }),

  deleteScript: asyncHandler(async (req: Request, res: Response) => {
    await removeBuildScript(String(req.params.scriptId || ""));
    res.formatter.ok({ ok: true });
  }),

  queue: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(getBuildQueueSnapshot());
  }),

  listBuilds: asyncHandler(async (req: Request, res: Response) => {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const status = asStatus(req.query.status);
    const scriptId = String(req.query.scriptId || "").trim() || undefined;
    const [builds, total] = await Promise.all([
      listBuilds({
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
        status,
        scriptId,
      }),
      countBuilds({ status, scriptId }),
    ]);
    res.formatter.ok({ queue: getBuildQueueSnapshot(), builds, total });
  }),

  getBuild: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok({ job: await getBuild(String(req.params.id || "")) });
  }),

  trigger: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { scriptId?: string; note?: string };
    const job = await triggerBuild({
      scriptId: String(body.scriptId || ""),
      triggeredBy: username(),
      note: body.note,
    });
    res.formatter.accepted({ job, queue: getBuildQueueSnapshot() });
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const job = await cancelBuild(
      String(req.params.id || ""),
      "Cancelled from Devops console",
    );
    res.formatter.ok({ job, queue: getBuildQueueSnapshot() });
  }),

  stdin: asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const body = (req.body ?? {}) as { data?: unknown; secret?: unknown };
    if (typeof body.data !== "string") {
      throw new AppError("stdin data must be a string", 400, "stdin_invalid");
    }
    sendBuildStdin(id, body.data, Boolean(body.secret));
    res.formatter.ok({ ok: true });
  }),

  log: asyncHandler(async (req: Request, res: Response) => {
    const { job, text, lines } = await readBuildLog(String(req.params.id || ""));
    res.formatter.ok({ job, text, lines });
  }),

  /** Queue + job status SSE (no high-volume log lines). */
  events: asyncHandler(async (req: Request, res: Response) => {
    const client = setupSse(req, res, { heartbeatMs: 15_000 });
    client.send("queue", { type: "queue", snapshot: getBuildQueueSnapshot() });
    client.send("hello", { ok: true, at: new Date().toISOString() });

    const unsub = subscribeBuildEvents((ev) => {
      if (client.closed) {
        unsub();
        return;
      }
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

  /** Live stdout/stderr for one job, with log-file replay. */
  stream: asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const { job, lines } = await readBuildLog(id);
    const client = setupSse(req, res, { heartbeatMs: 15_000 });
    client.send("job", { type: "job", job });
    for (const line of lines) {
      if (!client.send("log", { type: "log", buildId: id, ...line })) {
        client.close();
        return;
      }
    }
    if (job.status !== "queued" && job.status !== "running") {
      client.send("done", { type: "done", buildId: id, job });
    }

    const unsub = subscribeBuildEvents((ev) => {
      if (client.closed) {
        unsub();
        return;
      }
      if (ev.type === "log" && ev.buildId !== id) return;
      if (ev.type === "job" && ev.job.id !== id) return;
      if (ev.type === "done" && ev.buildId !== id) return;
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
};
