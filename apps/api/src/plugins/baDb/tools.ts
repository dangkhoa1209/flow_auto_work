import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import {
  formatQueryResultForAgent,
  runBaReadonlyQuery,
} from "./query.js";

/** Cursor SDK custom tools for BA read-only DB access. */
export function buildBaDbCustomTools(
  cfg: BaDbConnectionResolved,
): Record<
  string,
  {
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
  }
> {
  if (cfg.dialect === "mongodb") {
    return {
      query_readonly_mongo: {
        description:
          `Read-only MongoDB queries against the LOCKED database "${cfg.database}" on ${cfg.host} only. ` +
          `You cannot switch DB / pass database|db in JSON. Tenant codes are filters inside this DB, not other databases. ` +
          `JSON: {"op":"listCollections"} | {"op":"find","collection":"…","filter":{},"limit":20} | ` +
          `{"op":"aggregate","collection":"…","pipeline":[…]} | {"op":"count","collection":"…","filter":{}}. ` +
          `No $out/$merge/writes. Never invent credentials — use this tool only.`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                `JSON for read-only op on database "${cfg.database}" only (no database/db field)`,
            },
          },
          required: ["query"],
        },
        async execute(args) {
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
        `Read-only SQL against the LOCKED database "${cfg.database}" (${cfg.dialect}@${cfg.host}) only. ` +
        `No USE / no otherdb.table. Tenant codes = WHERE filters in this DB. ` +
        `Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN. Never invent credentials — use this tool only.`,
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: `Single read-only SQL statement in database "${cfg.database}"`,
          },
        },
        required: ["sql"],
      },
      async execute(args) {
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
