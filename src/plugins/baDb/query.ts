import { MongoClient, type Document } from "mongodb";
import type {
  BaDbConnectionResolved,
  BaDbDialect,
} from "../../workspace/baStore.js";

const QUERY_TIMEOUT_MS = 15_000;

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|replace|merge|grant|revoke|call|exec|execute|into\s+outfile|load_file|copy\s+|attach|detach|pragma|set\s+|begin|commit|rollback|lock|unlock|vacuum|analyze|optimize|handler|do\s+|prepare|deallocate|declare)\b/i;

const MONGO_WRITE_STAGES = new Set([
  "$out",
  "$merge",
  "$currentOp",
  "$listLocalSessions",
]);

/**
 * Allow only a single read-only SELECT / WITH…SELECT / SHOW / DESCRIBE / EXPLAIN.
 * Reject multi-statement and anything that mutates data/schema.
 */
export function assertReadonlySql(sqlRaw: string): string {
  const sql = sqlRaw.trim().replace(/;+\s*$/, "");
  if (!sql) throw new Error("Empty SQL");
  if (sql.includes(";")) {
    throw new Error("Multiple statements are not allowed");
  }
  if (FORBIDDEN.test(sql)) {
    throw new Error(
      "Only read-only queries are allowed (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN)",
    );
  }
  const head = sql.replace(/^\s*\(?\s*/i, "").slice(0, 12).toLowerCase();
  const ok =
    head.startsWith("select") ||
    head.startsWith("with") ||
    head.startsWith("show") ||
    head.startsWith("desc") ||
    head.startsWith("explain");
  if (!ok) {
    throw new Error(
      "Only read-only queries are allowed (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN)",
    );
  }
  return sql;
}

export type BaMongoQuery =
  | { op: "listCollections" }
  | {
      op: "find";
      collection: string;
      filter?: Document;
      projection?: Document;
      sort?: Document;
      limit?: number;
    }
  | {
      op: "aggregate";
      collection: string;
      pipeline: Document[];
    }
  | {
      op: "count";
      collection: string;
      filter?: Document;
    };

export function parseMongoQuery(raw: string): BaMongoQuery {
  const text = raw.trim();
  if (!text) throw new Error("Empty MongoDB query JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      'Invalid JSON. Example: {"op":"find","collection":"users","filter":{},"limit":20}',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MongoDB query must be a JSON object");
  }
  const q = parsed as Record<string, unknown>;
  const op = String(q.op || "").trim();
  if (op === "listCollections") return { op: "listCollections" };

  const collection = String(q.collection || "").trim();
  if (!collection) throw new Error("collection is required");
  if (!/^[a-zA-Z0-9._-]+$/.test(collection)) {
    throw new Error("Invalid collection name");
  }

  if (op === "find") {
    const limitRaw = Number(q.limit);
    return {
      op: "find",
      collection,
      filter: (q.filter as Document) || {},
      projection: q.projection as Document | undefined,
      sort: q.sort as Document | undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : undefined,
    };
  }
  if (op === "count") {
    return {
      op: "count",
      collection,
      filter: (q.filter as Document) || {},
    };
  }
  if (op === "aggregate") {
    if (!Array.isArray(q.pipeline)) {
      throw new Error("aggregate requires pipeline array");
    }
    for (const stage of q.pipeline) {
      if (!stage || typeof stage !== "object") {
        throw new Error("Invalid aggregation stage");
      }
      for (const key of Object.keys(stage as object)) {
        if (MONGO_WRITE_STAGES.has(key) || key.startsWith("$out")) {
          throw new Error(`Aggregation stage ${key} is not allowed (read-only)`);
        }
      }
    }
    return {
      op: "aggregate",
      collection,
      pipeline: q.pipeline as Document[],
    };
  }
  throw new Error(
    'op must be listCollections | find | aggregate | count',
  );
}

export type BaDbQueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  dialect: BaDbDialect;
  elapsedMs: number;
};

async function loadMysql() {
  try {
    return await import("mysql2/promise");
  } catch {
    throw new Error(
      "Package mysql2 is not installed — run `npm install mysql2` on the server",
    );
  }
}

async function loadPg(): Promise<{
  Client: new (config: Record<string, unknown>) => {
    connect: () => Promise<void>;
    query: (sql: string) => Promise<{
      rows: Record<string, unknown>[];
      fields?: Array<{ name: string }>;
    }>;
    end: () => Promise<void>;
  };
}> {
  try {
    const mod = (await import("pg")) as {
      default?: { Client: unknown };
      Client?: unknown;
    };
    const Client = (mod.default?.Client || mod.Client) as unknown;
    if (!Client) throw new Error("pg.Client missing");
    return { Client: Client as never };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(msg)) {
      throw new Error(
        "Package pg is not installed — run `npm install pg` on the server",
      );
    }
    throw err;
  }
}

function serializeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
    return `<binary ${v.length}b>`;
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") {
    try {
      return JSON.parse(
        JSON.stringify(v, (_k, val) => {
          if (val && typeof val === "object" && val._bsontype === "ObjectID") {
            return String(val);
          }
          if (typeof val === "object" && val !== null && "toHexString" in val) {
            try {
              return String(val);
            } catch {
              return val;
            }
          }
          return val;
        }),
      );
    } catch {
      return String(v);
    }
  }
  return v;
}

function docsToResult(
  docs: Record<string, unknown>[],
  dialect: BaDbDialect,
  started: number,
): BaDbQueryResult {
  const rows = docs.map((d) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) out[k] = serializeCell(v);
    return out;
  });
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated: false,
    dialect,
    elapsedMs: Date.now() - started,
  };
}

export function buildMongoUri(cfg: BaDbConnectionResolved): string {
  const auth = cfg.username
    ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
    : "";
  const params = new URLSearchParams();
  if (cfg.username) {
    params.set("authSource", cfg.database || "admin");
  }
  if (cfg.ssl) params.set("tls", "true");
  const q = params.toString() ? `?${params.toString()}` : "";
  return `mongodb://${auth}${cfg.host}:${cfg.port}/${encodeURIComponent(cfg.database)}${q}`;
}

async function withMongo<T>(
  cfg: BaDbConnectionResolved,
  fn: (dbName: string, client: MongoClient) => Promise<T>,
): Promise<T> {
  const uri = buildMongoUri(cfg);
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: QUERY_TIMEOUT_MS,
    connectTimeoutMS: QUERY_TIMEOUT_MS,
  });
  try {
    await client.connect();
    return await fn(cfg.database, client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function queryMongo(
  cfg: BaDbConnectionResolved,
  queryRaw: string,
): Promise<BaDbQueryResult> {
  const q = parseMongoQuery(queryRaw);
  const started = Date.now();
  return withMongo(cfg, async (dbName, client) => {
    const db = client.db(dbName);
    if (q.op === "listCollections") {
      const cols = await db.listCollections().toArray();
      const docs = cols.map((c) => ({
        name: c.name,
        type: (c as { type?: string }).type || "collection",
      }));
      return docsToResult(docs, "mongodb", started);
    }
    if (q.op === "count") {
      const n = await db.collection(q.collection).countDocuments(q.filter || {}, {
        maxTimeMS: QUERY_TIMEOUT_MS,
      });
      return docsToResult([{ count: n }], "mongodb", started);
    }
    if (q.op === "find") {
      let cursor = db.collection(q.collection).find(q.filter || {}, {
        maxTimeMS: QUERY_TIMEOUT_MS,
        projection: q.projection,
      });
      if (q.sort) cursor = cursor.sort(q.sort);
      if (q.limit != null) cursor = cursor.limit(q.limit);
      const docs = (await cursor.toArray()) as Record<string, unknown>[];
      return docsToResult(docs, "mongodb", started);
    }
    // aggregate — no forced $limit; caller controls pipeline
    const docs = (await db
      .collection(q.collection)
      .aggregate(q.pipeline, { maxTimeMS: QUERY_TIMEOUT_MS })
      .toArray()) as Record<string, unknown>[];
    return docsToResult(docs, "mongodb", started);
  });
}

async function queryMysql(
  cfg: BaDbConnectionResolved,
  sql: string,
): Promise<BaDbQueryResult> {
  const mysql = await loadMysql();
  const started = Date.now();
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? {} : undefined,
    connectTimeout: QUERY_TIMEOUT_MS,
    multipleStatements: false,
  });
  try {
    const [rawRows, fields] = await conn.query({
      sql,
      timeout: QUERY_TIMEOUT_MS,
    });
    const list = Array.isArray(rawRows) ? (rawRows as Record<string, unknown>[]) : [];
    const columns =
      Array.isArray(fields) && fields.length
        ? fields.map((f: { name?: string }) => String(f.name || ""))
        : list[0]
          ? Object.keys(list[0])
          : [];
    const rows = list.map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of columns) out[c] = serializeCell(r[c]);
      return out;
    });
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated: false,
      dialect: "mysql",
      elapsedMs: Date.now() - started,
    };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function queryPostgres(
  cfg: BaDbConnectionResolved,
  sql: string,
): Promise<BaDbQueryResult> {
  const { Client } = await loadPg();
  const started = Date.now();
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const res = await client.query(sql);
    const list = (res.rows || []) as Record<string, unknown>[];
    const columns =
      res.fields?.map((f) => f.name) ||
      (list[0] ? Object.keys(list[0]) : []);
    const rows = list.map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of columns) out[c] = serializeCell(r[c]);
      return out;
    });
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated: false,
      dialect: "postgres",
      elapsedMs: Date.now() - started,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** SQL dialects: pass SQL. MongoDB: pass JSON query string. */
export async function runBaReadonlyQuery(
  cfg: BaDbConnectionResolved,
  queryRaw: string,
): Promise<BaDbQueryResult> {
  if (cfg.dialect === "mongodb") return queryMongo(cfg, queryRaw);
  const sql = assertReadonlySql(queryRaw);
  if (cfg.dialect === "mysql") return queryMysql(cfg, sql);
  if (cfg.dialect === "postgres") return queryPostgres(cfg, sql);
  throw new Error(`Unsupported dialect: ${cfg.dialect}`);
}

export async function testBaDbConnection(
  cfg: BaDbConnectionResolved,
): Promise<{ ok: true; dialect: BaDbDialect; elapsedMs: number }> {
  if (cfg.dialect === "mongodb") {
    const started = Date.now();
    await withMongo(cfg, async (_dbName, client) => {
      await client.db("admin").command({ ping: 1 });
    });
    return { ok: true, dialect: "mongodb", elapsedMs: Date.now() - started };
  }
  const res = await runBaReadonlyQuery(cfg, "SELECT 1 AS ok");
  return { ok: true, dialect: cfg.dialect, elapsedMs: res.elapsedMs };
}

export function formatQueryResultForAgent(res: BaDbQueryResult): string {
  const meta = [
    `dialect=${res.dialect}`,
    `rows=${res.rowCount}`,
    `elapsedMs=${res.elapsedMs}`,
  ].join(", ");
  if (!res.rows.length) {
    return `Query OK — no rows.\n(${meta})`;
  }
  return `${JSON.stringify({ columns: res.columns, rows: res.rows }, null, 2)}\n\n(${meta})`;
}
