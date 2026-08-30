import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { setupSse } from "../sseHelper.js";
import { jobQueue } from "../../queue.js";
import { subscribeRealtime } from "../../plugins/realtime/hub.js";
import {
  headerProjectFromExpress,
  headerUserFromExpress,
} from "../middleware/workspaceAuth.js";

/**
 * GET /api/events — Server-Sent Events for UI realtime.
 * Status / job / progress / chat are scoped to the connected user + project.
 */
export const eventsController = {
  stream: asyncHandler(async (req: Request, res: Response) => {
    const client = setupSse(req, res, { heartbeatMs: 15_000 });
    const ownerUsername = headerUserFromExpress(req);
    const workspaceProjectId = headerProjectFromExpress(req);
    const viewer = { ownerUsername, workspaceProjectId };

    const sendStatus = () => {
      const snap = jobQueue.snapshotFor(viewer);
      return client.send("status", {
        type: "status",
        currentJobId: snap.currentJobId,
        currentJobIds: snap.currentJobIds,
        queueLength: snap.queued,
        running: snap.running,
      });
    };

    sendStatus();
    client.send("hello", { ok: true, at: new Date().toISOString() });

    const unsub = subscribeRealtime((ev) => {
      if (client.closed) {
        unsub();
        return;
      }
      if (ev.type === "status") {
        if (!sendStatus()) unsub();
        return;
      }
      if (!jobQueue.eventVisibleTo(ev, viewer)) return;
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
