import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApiRoutes } from "./api/routes.js";
import { getConfig } from "./config.js";

export function createApp() {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      teamsEnabled: getConfig().teamsEnabled,
      ui: "/",
    }),
  );

  app.route("/api", createApiRoutes());

  app.use(
    "/*",
    serveStatic({
      root: "./public",
      index: "index.html",
    }),
  );

  return app;
}
