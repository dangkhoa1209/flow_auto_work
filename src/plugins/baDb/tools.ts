import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import {
  formatQueryResultForAgent,
  runBaReadonlyQuery,
} from "./query.js";

/** Cursor SDK custom tools for BA read-only DB access. */
export function buildBaDbCustomTools(cfg: BaDbConnectionResolved) {
  if (cfg.dialect === "mongodb") {
    return {
      query_readonly_mongo: {
        description:
          `Run a read-only MongoDB query against ${cfg.database}@${cfg.host}. ` +
          `Pass JSON: {"op":"listCollections"} | {"op":"find","collection":"…","filter":{},"limit":20} | ` +
          `{"op":"aggregate","collection":"…","pipeline":[…]} | {"op":"count","collection":"…","filter":{}}. ` +
          `No $out/$merge/writes. Never invent credentials — use this tool only.`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "JSON string for the MongoDB read-only operation",
            },
          },
          required: ["query"],
        },
        async execute(args: { query?: string }) {
          const query = String(args?.query || "");
          try {
            const res = await runBaReadonlyQuery(cfg, query);
            return formatQueryResultForAgent(res);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Query failed: ${msg}`;
          }
        },
      },
    };
  }

  return {
    query_readonly_sql: {
      description:
        `Run a read-only SQL query against the project ${cfg.dialect} database ` +
        `(${cfg.database}@${cfg.host}). Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN. ` +
        `Never invent credentials — use this tool only.`,
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "Single read-only SQL statement",
          },
        },
        required: ["sql"],
      },
      async execute(args: { sql?: string }) {
        const sql = String(args?.sql || "");
        try {
          const res = await runBaReadonlyQuery(cfg, sql);
          return formatQueryResultForAgent(res);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Query failed: ${msg}`;
        }
      },
    },
  };
}
