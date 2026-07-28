import type { Request, Response } from "express";
import { asyncHandler } from "../../../src/utils/asyncHandler.js";
import { setupSse } from "../../../src/api/sseHelper.js";
import { qaJobQueue } from "../queue.js";
import { subscribeQaRealtime } from "../realtime/hub.js";
import type { QaRealtimeEvent } from "../realtime/hub.js";

export const qaEventsController = {
  stream: asyncHandler(async (req: Request, res: Response) => {
    const client = setupSse(req, res, { heartbeatMs: 20_000 });
    const snap = qaJobQueue.snapshot();
    client.send("status", {
      type: "status",
      currentJobId: snap.currentJobId,
      currentJobIds: snap.currentJobIds,
      queueLength: snap.queued,
      running: snap.running,
    });
    client.send("hello", { ok: true, at: new Date().toISOString() });

    const unsub = subscribeQaRealtime((ev: QaRealtimeEvent) => {
      if (client.closed) {
        unsub();
        return;
      }
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
