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

  return { server, host, port };
}

/** @deprecated Use createApp from ./app.js — kept for transitional imports */
export { createApp } from "./app.js";
