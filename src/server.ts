import { existsSync } from "node:fs";
import { join } from "node:path";
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

  const vueDist = join(process.cwd(), "web", "dist");
  const useVue = existsSync(join(vueDist, "index.html"));
  const staticRoot = useVue ? "./web/dist" : "./public";

  app.use(
    "/*",
    serveStatic({
      root: staticRoot,
      index: "index.html",
    }),
  );

  if (useVue) {
    app.get("*", async (c) => {
      const { readFile } = await import("node:fs/promises");
      try {
        const html = await readFile(join(vueDist, "index.html"), "utf8");
        return c.html(html);
      } catch {
        return c.text("UI not built — run npm run build:web", 503);
      }
    });
  }

  return app;
}
