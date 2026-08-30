/**
 * HTTP server entry — listen only.
 * Bootstrapping (config, mongo, indexes) stays in `index.ts`.
 */
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";

export type ListenResult = {
  server: Server;
  host: string;
  port: number;
};

export async function startHttpServer(): Promise<ListenResult> {
  const config = getConfig();
  const app = await createApp();
  const host = config.HOST;
  const port = config.PORT;

  const server = app.listen(port, host, () => {
    logger.info(`Server OK — http://${host}:${port}/ (Express)`);
  });

  if (config.WORKBENCH_TERMINAL) {
    const { attachWorkbenchTerminal } = await import(
      "./plugins/terminal/ws.js"
    );
    attachWorkbenchTerminal(server);
  } else {
    logger.info("Workbench terminal off (set WORKBENCH_TERMINAL=1 for local PTY)");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Graceful shutdown", { signal });
    try {
      const { shutdownBuildQueue } = await import("./modules/devops/index.js");
      await shutdownBuildQueue(15_000);
    } catch (err) {
      logger.warn("Build queue shutdown error", { err: String(err) });
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 3000).unref?.();
    });
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  return { server, host, port };
}

/** @deprecated Use createApp from ./app.js — kept for transitional imports */
export { createApp } from "./app.js";
