/**
 * WebSocket PTY bridge for internal Workbench terminal.
 * Path: /api/terminal/ws?access_token=…&project=…
 */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyAccessToken } from "../../auth/tokens.js";
import { logger } from "../../logger.js";
import { resolveRuntimeContext } from "../../workspace/resolve.js";
import { isWorkbenchTerminalAllowed } from "./gate.js";
import { spawnRepoPty, type PtySession } from "./pty.js";

const IDLE_MS = 30 * 60 * 1000;
const sessions = new Map<string, { ws: WebSocket; pty: PtySession }>();

function sessionKey(user: string, projectId: string): string {
  return `${user}::${projectId}`;
}

function clientIp(req: IncomingMessage): string | undefined {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]?.trim();
  return req.socket.remoteAddress;
}

function parseQuery(url: string): URLSearchParams {
  try {
    return new URL(url, "http://127.0.0.1").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function killSession(key: string): void {
  const cur = sessions.get(key);
  if (!cur) return;
  sessions.delete(key);
  try {
    cur.pty.pty.kill();
  } catch {
    /* ignore */
  }
  try {
    if (cur.ws.readyState === cur.ws.OPEN) cur.ws.close();
  } catch {
    /* ignore */
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

/**
 * Attach `/api/terminal/ws` to the existing HTTP server (noSeparateServer).
 */
export function attachWorkbenchTerminal(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    if (!url.startsWith("/api/terminal/ws")) return;

    const remote = clientIp(req);
    if (!isWorkbenchTerminalAllowed(remote)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ws, req);
    });
  });

  // Idle sweeper
  setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (now - s.pty.lastActiveAt > IDLE_MS) {
        logger.info("Workbench PTY idle timeout", { key });
        killSession(key);
      }
    }
  }, 60_000).unref();

  logger.info("Workbench terminal WebSocket attached at /api/terminal/ws");
}

async function handleConnection(
  ws: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  const q = parseQuery(req.url || "");
  const token = (q.get("access_token") || q.get("token") || "").trim();
  const projectId = (q.get("project") || q.get("p") || "").trim();

  let username = "";
  try {
    if (!token) throw new Error("access_token required");
    username = verifyAccessToken(token).sub;
  } catch (err) {
    sendJson(ws, {
      type: "error",
      message: err instanceof Error ? err.message : "Unauthorized",
    });
    ws.close(4401, "unauthorized");
    return;
  }

  if (!projectId) {
    sendJson(ws, { type: "error", message: "project query required" });
    ws.close(4400, "bad request");
    return;
  }

  let repoPath = "";
  try {
    const ctx = await resolveRuntimeContext({
      gitlabUsername: username,
      projectId,
      requireLocalClone: true,
    });
    repoPath = ctx.repoPath;
  } catch (err) {
    sendJson(ws, {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    ws.close(4403, "forbidden");
    return;
  }

  const key = sessionKey(username, projectId);
  killSession(key);

  const cols = Math.max(20, Number(q.get("cols")) || 120);
  const rows = Math.max(8, Number(q.get("rows")) || 32);
  let session: PtySession;
  try {
    session = spawnRepoPty({ cwd: repoPath, cols, rows });
  } catch (err) {
    sendJson(ws, {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    ws.close(1011, "pty failed");
    return;
  }

  sessions.set(key, { ws, pty: session });

  sendJson(ws, {
    type: "ready",
    cwd: repoPath,
    cols,
    rows,
    shellPid: session.pty.pid,
  });

  session.pty.onData((data) => {
    session.touch();
    if (ws.readyState === ws.OPEN) {
      // Prefix so client can distinguish control JSON vs output
      ws.send(JSON.stringify({ type: "out", data }));
    }
  });

  session.pty.onExit(({ exitCode, signal }) => {
    sendJson(ws, { type: "exit", exitCode, signal });
    sessions.delete(key);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });

  ws.on("message", (raw) => {
    session.touch();
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
    else text = Buffer.from(raw as ArrayBuffer).toString("utf8");

    try {
      const msg = JSON.parse(text) as {
        type?: string;
        data?: string;
        cols?: number;
        rows?: number;
      };
      if (msg.type === "input" && typeof msg.data === "string") {
        session.pty.write(msg.data);
        return;
      }
      if (msg.type === "resize") {
        const c = Math.max(20, Number(msg.cols) || cols);
        const r = Math.max(8, Number(msg.rows) || rows);
        session.pty.resize(c, r);
        return;
      }
    } catch {
      // Treat as raw stdin
      session.pty.write(text);
    }
  });

  ws.on("close", () => {
    killSession(key);
  });

  ws.on("error", (err) => {
    logger.warn("Workbench terminal WS error", { err: String(err), key });
    killSession(key);
  });
}
