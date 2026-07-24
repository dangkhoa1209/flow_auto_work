import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { setupSse } from "../sseHelper.js";
import { jobQueue } from "../../queue.js";
import { subscribeRealtime } from "../../realtime/hub.js";

/**
 * GET /api/events — Server-Sent Events for UI realtime.
 * Express-native (no Hono streamSSE).
 */
export const eventsController = {
  stream: asyncHandler(async (req: Request, res: Response) => {
    const client = setupSse(req, res, { heartbeatMs: 20_000 });

    const snap = jobQueue.snapshot();
    client.send("status", {
      type: "status",
      currentJobId: snap.currentJobId,
      queueLength: snap.queued,
      running: snap.running,
    });
    client.send("hello", { ok: true, at: new Date().toISOString() });

    const unsub = subscribeRealtime((ev) => {
      if (client.closed) {
        unsub();
        return;
      }
      if (!client.send(ev.type, ev)) {
        unsub();
      }
    });

    // Keep the request open until client disconnects
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
