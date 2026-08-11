import type { Request, Response } from "express";

export type SseClient = {
  /** Write one SSE event. Returns false if the socket is gone. */
  send: (event: string, data: unknown) => boolean;
  /** Whether the client has disconnected */
  readonly closed: boolean;
  /** Tear down heartbeat + close flag (idempotent) */
  close: () => void;
};

export type SseSetupOptions = {
  /** Heartbeat interval ms (default 20s). Set 0 to disable. */
  heartbeatMs?: number;
  /** Optional comment/event name for heartbeats */
  heartbeatEvent?: string;
};

/**
 * Prepare an Express response for Server-Sent Events.
 *
 * Express has no built-in SSE helper (unlike Hono's streamSSE).
 * Call once per connection, then use `client.send()` / subscribe hub / cleanup on close.
 *
 * Important headers:
 * - Content-Type: text/event-stream
 * - Cache-Control: no-cache (and often no-transform)
 * - Connection: keep-alive
 * - X-Accel-Buffering: no (disable nginx buffering)
 */
export function setupSse(
  req: Request,
  res: Response,
  opts: SseSetupOptions = {},
): SseClient {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const heartbeatEvent = opts.heartbeatEvent ?? "ping";

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // Flush headers immediately so EventSource connects
  res.flushHeaders?.();

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const send = (event: string, data: unknown): boolean => {
    if (closed || res.writableEnded) {
      close();
      return false;
    }
    try {
      // SSE wire format: event + data (+ blank line)
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      close();
      return false;
    }
  };

  // Client navigated away / tab closed → prevent listener leaks
  req.on("close", close);
  res.on("close", close);
  res.on("error", close);

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (closed || res.writableEnded) {
        close();
        return;
      }
      try {
        // Comment keep-alive (proxies) + named ping (client)
        res.write(`: ping ${Date.now()}\n\n`);
        if (!send(heartbeatEvent, { at: new Date().toISOString() })) {
          close();
        }
      } catch {
        close();
      }
    }, heartbeatMs);
    // Don't keep the process alive solely for heartbeats
    heartbeat.unref?.();
  }

  return {
    send,
    get closed() {
      return closed;
    },
    close,
  };
}
