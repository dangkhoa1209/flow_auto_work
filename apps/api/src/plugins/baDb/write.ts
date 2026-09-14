import { MongoClient, ObjectId, type Document } from "mongodb";
import type {
  BaDbConnectionResolved,
  BaDbDialect,
} from "../../workspace/baStore.js";
import { buildMongoUri } from "./query.js";

const WRITE_TIMEOUT_MS = 20_000;
const MAX_AFFECTED = 50;

export type BaDbWriteOp = "insert" | "update" | "delete";

export type BaDbWriteRequest = {
  op: BaDbWriteOp;
  /** SQL table or Mongo collection */
  collection: string;
  /** Insert document / update $set fields */
  data?: Record<string, unknown> | null;
  /** WHERE / Mongo filter — required for update|delete */
  filter?: Record<string, unknown> | null;
};

export type BaDbWriteResult = {
  dialect: BaDbDialect;
  op: BaDbWriteOp;
  collection: string;
  /** Primary key / ObjectId string when insert succeeds */
  createdId: string | null;
  matchedCount: number;
  modifiedCount: number;
  deletedCount: number;
  /** Echo of written/resolved document for placeholders */
  document: Record<string, unknown> | null;
  elapsedMs: number;
};

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MONGO_COLL_RE = /^[a-zA-Z0-9._-]+$/;

export function assertSafeIdentifier(name: string, kind: string): string {
  const n = String(name || "").trim();
  if (!n || !IDENT_RE.test(n)) {
    throw new Error(`Invalid ${kind} name "${name}"`);
  }
  return n;
}

function assertSafeCollection(
  name: string,
  dialect: BaDbDialect,
): string {
  const n = String(name || "").trim();
  if (dialect === "mongodb") {
    if (!n || !MONGO_COLL_RE.test(n)) {
      throw new Error(`Invalid collection name "${name}"`);
    }
    return n;
  }
  return assertSafeIdentifier(n, "table");
}

function assertNonEmptyFilter(
  filter: Record<string, unknown> | null | undefined,
  op: string,
): Record<string, unknown> {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new Error(`${op} requires a non-empty filter`);
  }
  if (!Object.keys(filter).length) {
    throw new Error(`${op} requires a non-empty filter (refusing full-table write)`);
  }
  return filter;
}

function quoteIdent(dialect: "mysql" | "postgres", name: string): string {
  if (dialect === "postgres") return `"${name}"`;
  return `\`${name}\``;
}

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
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{
      rows: Record<string, unknown>[];
      rowCount?: number | null;
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

/** Equality-only Mongo filter — reject operator injection ($gt, $regex, …). */
export function assertSafeMongoFilter(
  filter: Record<string, unknown>,
): Document {
  const out: Document = {};
  for (const [key, val] of Object.entries(filter)) {
    if (!key || key.startsWith("$")) {
      throw new Error(`Mongo filter key "${key}" is not allowed`);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
      throw new Error(`Invalid Mongo filter field "${key}"`);
    }
    if (val !== null && typeof val === "object") {
      throw new Error(
        `Mongo filter field "${key}" must be a scalar (equality only)`,
      );
    }
    out[key] = val;
  }
  if (
    typeof out._id === "string" &&
    /^[a-fA-F0-9]{24}$/.test(out._id as string)
  ) {
    try {
      out._id = new ObjectId(out._id as string);
    } catch {
      /* keep string */
    }
  }
  return out;
}

function coerceMongoFilter(filter: Record<string, unknown>): Document {
  return assertSafeMongoFilter(filter);
}

async function withMongo<T>(
  cfg: BaDbConnectionResolved,
  fn: (dbName: string, client: MongoClient) => Promise<T>,
): Promise<T> {
  const uri = buildMongoUri(cfg);
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: WRITE_TIMEOUT_MS,
    connectTimeoutMS: WRITE_TIMEOUT_MS,
    directConnection: true,
  });
  try {
    await client.connect();
    return await fn(cfg.database, client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function writeMongo(
  cfg: BaDbConnectionResolved,
  req: BaDbWriteRequest,
): Promise<BaDbWriteResult> {
  const collection = assertSafeCollection(req.collection, "mongodb");
  const started = Date.now();
  return withMongo(cfg, async (dbName, client) => {
    const col = client.db(dbName).collection(collection);
    if (req.op === "insert") {
      if (!req.data || typeof req.data !== "object" || Array.isArray(req.data)) {
        throw new Error("insert requires data object");
      }
      const doc = { ...req.data } as Document;
      const result = await col.insertOne(doc);
      const createdId = String(result.insertedId);
      return {
        dialect: "mongodb" as const,
        op: "insert" as const,
        collection,
        createdId,
        matchedCount: 1,
        modifiedCount: 1,
        deletedCount: 0,
        document: { ...req.data, _id: createdId, id: createdId },
        elapsedMs: Date.now() - started,
      };
    }
    const filter = coerceMongoFilter(
      assertNonEmptyFilter(req.filter, req.op),
    );
    if (req.op === "update") {
      if (!req.data || typeof req.data !== "object" || Array.isArray(req.data)) {
        throw new Error("update requires data object");
      }
      const matched = await col.countDocuments(filter, {
        limit: MAX_AFFECTED + 1,
        maxTimeMS: WRITE_TIMEOUT_MS,
      });
      if (matched > MAX_AFFECTED) {
        throw new Error(
          `update matched ${matched} docs — max ${MAX_AFFECTED} (narrow the filter)`,
        );
      }
      const result = await col.updateMany(
        filter,
        { $set: req.data as Document },
        { maxTimeMS: WRITE_TIMEOUT_MS },
      );
      return {
        dialect: "mongodb" as const,
        op: "update" as const,
        collection,
        createdId: null,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        deletedCount: 0,
        document: { ...req.data, ...Object.fromEntries(
          Object.entries(req.filter || {}).map(([k, v]) => [k, v]),
        ) },
        elapsedMs: Date.now() - started,
      };
    }
    // delete
    const matched = await col.countDocuments(filter, {
      limit: MAX_AFFECTED + 1,
      maxTimeMS: WRITE_TIMEOUT_MS,
    });
    if (matched > MAX_AFFECTED) {
      throw new Error(
        `delete matched ${matched} docs — max ${MAX_AFFECTED} (narrow the filter)`,
      );
    }
    const result = await col.deleteMany(filter);
    return {
      dialect: "mongodb" as const,
      op: "delete" as const,
      collection,
      createdId: null,
      matchedCount: result.deletedCount,
      modifiedCount: 0,
      deletedCount: result.deletedCount,
      document: { ...(req.filter || {}) },
      elapsedMs: Date.now() - started,
    };
  });
}

function buildWhereSql(
  dialect: "mysql" | "postgres",
  filter: Record<string, unknown>,
  startIndex: number,
): { clause: string; values: unknown[]; nextIndex: number } {
  const parts: string[] = [];
  const values: unknown[] = [];
  let i = startIndex;
  for (const [key, val] of Object.entries(filter)) {
    const col = assertSafeIdentifier(key, "column");
    const ph = dialect === "postgres" ? `$${i}` : "?";
    parts.push(`${quoteIdent(dialect, col)} = ${ph}`);
    values.push(val);
    i++;
  }
  return { clause: parts.join(" AND "), values, nextIndex: i };
}

async function writeMysql(
  cfg: BaDbConnectionResolved,
  req: BaDbWriteRequest,
): Promise<BaDbWriteResult> {
  const table = assertSafeCollection(req.collection, "mysql");
  const started = Date.now();
  const mysql = await loadMysql();
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? {} : undefined,
    connectTimeout: WRITE_TIMEOUT_MS,
    multipleStatements: false,
  });
  try {
    if (req.op === "insert") {
      if (!req.data || typeof req.data !== "object" || Array.isArray(req.data)) {
        throw new Error("insert requires data object");
      }
      const keys = Object.keys(req.data);
      if (!keys.length) throw new Error("insert data is empty");
      const cols = keys.map((k) =>
        quoteIdent("mysql", assertSafeIdentifier(k, "column")),
      );
      const placeholders = keys.map(() => "?").join(", ");
      const values = keys.map((k) => req.data![k]);
      const sql = `INSERT INTO ${quoteIdent("mysql", table)} (${cols.join(", ")}) VALUES (${placeholders})`;
      const [result] = await conn.execute(sql, values);
      const header = result as { insertId?: number; affectedRows?: number };
      const createdId =
        header.insertId != null && Number(header.insertId) > 0
          ? String(header.insertId)
          : typeof req.data.id === "string" || typeof req.data.id === "number"
            ? String(req.data.id)
            : null;
      return {
        dialect: "mysql",
        op: "insert",
        collection: table,
        createdId,
        matchedCount: 1,
        modifiedCount: Number(header.affectedRows || 1),
        deletedCount: 0,
        document: {
          ...req.data,
          ...(createdId ? { id: createdId } : {}),
        },
        elapsedMs: Date.now() - started,
      };
    }

    const filter = assertNonEmptyFilter(req.filter, req.op);
    const where = buildWhereSql("mysql", filter, 1);

    if (req.op === "update") {
      if (!req.data || typeof req.data !== "object" || Array.isArray(req.data)) {
        throw new Error("update requires data object");
      }
      const keys = Object.keys(req.data);
      if (!keys.length) throw new Error("update data is empty");
      const setParts = keys.map(
        (k) =>
          `${quoteIdent("mysql", assertSafeIdentifier(k, "column"))} = ?`,
      );
      const values = [...keys.map((k) => req.data![k]), ...where.values];
      const countSql = `SELECT COUNT(*) AS c FROM ${quoteIdent("mysql", table)} WHERE ${where.clause}`;
      const [countRows] = await conn.execute(countSql, where.values);
      const countList = countRows as Array<{ c: number }>;
      const matched = Number(countList[0]?.c || 0);
      if (matched > MAX_AFFECTED) {
        throw new Error(
          `update matched ${matched} rows — max ${MAX_AFFECTED} (narrow the filter)`,
        );
      }
      const sql = `UPDATE ${quoteIdent("mysql", table)} SET ${setParts.join(", ")} WHERE ${where.clause}`;
      const [result] = await conn.execute(sql, values);
      const header = result as { affectedRows?: number };
      return {
        dialect: "mysql",
        op: "update",
        collection: table,
        createdId: null,
        matchedCount: matched,
        modifiedCount: Number(header.affectedRows || 0),
        deletedCount: 0,
        document: { ...req.data, ...filter },
        elapsedMs: Date.now() - started,
      };
    }

    const countSql = `SELECT COUNT(*) AS c FROM ${quoteIdent("mysql", table)} WHERE ${where.clause}`;
    const [countRows] = await conn.execute(countSql, where.values);
    const countList = countRows as Array<{ c: number }>;
    const matched = Number(countList[0]?.c || 0);
    if (matched > MAX_AFFECTED) {
      throw new Error(
        `delete matched ${matched} rows — max ${MAX_AFFECTED} (narrow the filter)`,
      );
    }
    const sql = `DELETE FROM ${quoteIdent("mysql", table)} WHERE ${where.clause}`;
    const [result] = await conn.execute(sql, where.values);
    const header = result as { affectedRows?: number };
    return {
      dialect: "mysql",
      op: "delete",
      collection: table,
      createdId: null,
      matchedCount: matched,
      modifiedCount: 0,
      deletedCount: Number(header.affectedRows || 0),
      document: { ...filter },
      elapsedMs: Date.now() - started,
    };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function writePostgres(
  cfg: BaDbConnectionResolved,
  req: BaDbWriteRequest,
): Promise<BaDbWriteResult> {
  const table = assertSafeCollection(req.collection, "postgres");
  const started = Date.now();
  const { Client } = await loadPg();
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: WRITE_TIMEOUT_MS,
    statement_timeout: WRITE_TIMEOUT_MS,
    query_timeout: WRITE_TIMEOUT_MS,
  });
  await client.connect();
  try {
    if (req.op === "insert") {
      if (!req.data || typeof req.data !== "object" || Array.isArray(req.data)) {
        throw new Error("insert requires data object");
      }
      const keys = Object.keys(req.data);
      if (!keys.length) throw new Error("insert data is empty");
      const cols = keys.map((k) =>
        quoteIdent("postgres", assertSafeIdentifier(k, "column")),
      );
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
      const values = keys.map((k) => req.data![k]);
      const sql = `INSERT INTO ${quoteIdent("postgres", table)} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`;
      const res = await client.query(sql, values);
      const row = (res.rows[0] || {}) as Record<string, unknown>;
      const createdId =
        row.id != null
          ? String(row.id)
          : typeof req.data.id === "string" || typeof req.data.id === "number"
            ? String(req.data.id)
            : null;
      return {
        dialect: "postgres",
        op: "insert",
        collection: table,
        createdId,
        matchedCount: 1,
        modifiedCount: 1,
        deletedCount: 0,
        document: { ...row, ...(createdId ? { id: createdId } : {}) },
        elapsedMs: Date.now() - started,
      };
    }

    const filter = assertNonEmptyFilter(req.filter, req.op);
    if (req.op === "update") {
      if (!req.data || typeof req.data !== "object" || Array.isArray(req.data)) {
        throw new Error("update requires data object");
      }
      const keys = Object.keys(req.data);
      if (!keys.length) throw new Error("update data is empty");
      const countWhere = buildWhereSql("postgres", filter, 1);
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS c FROM ${quoteIdent("postgres", table)} WHERE ${countWhere.clause}`,
        countWhere.values,
      );
      const matched = Number(countRes.rows[0]?.c || 0);
      if (matched > MAX_AFFECTED) {
        throw new Error(
          `update matched ${matched} rows — max ${MAX_AFFECTED} (narrow the filter)`,
        );
      }
      const setParts = keys.map(
        (k, i) =>
          `${quoteIdent("postgres", assertSafeIdentifier(k, "column"))} = $${i + 1}`,
      );
      const where = buildWhereSql("postgres", filter, keys.length + 1);
      const values = [...keys.map((k) => req.data![k]), ...where.values];
      const sql = `UPDATE ${quoteIdent("postgres", table)} SET ${setParts.join(", ")} WHERE ${where.clause} RETURNING *`;
      const res = await client.query(sql, values);
      return {
        dialect: "postgres",
        op: "update",
        collection: table,
        createdId: null,
        matchedCount: matched,
        modifiedCount: res.rowCount || 0,
        deletedCount: 0,
        document: (res.rows[0] as Record<string, unknown>) || {
          ...req.data,
          ...filter,
        },
        elapsedMs: Date.now() - started,
      };
    }

    const where = buildWhereSql("postgres", filter, 1);
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM ${quoteIdent("postgres", table)} WHERE ${where.clause}`,
      where.values,
    );
    const matched = Number(countRes.rows[0]?.c || 0);
    if (matched > MAX_AFFECTED) {
      throw new Error(
        `delete matched ${matched} rows — max ${MAX_AFFECTED} (narrow the filter)`,
      );
    }
    const sql = `DELETE FROM ${quoteIdent("postgres", table)} WHERE ${where.clause}`;
    const res = await client.query(sql, where.values);
    return {
      dialect: "postgres",
      op: "delete",
      collection: table,
      createdId: null,
      matchedCount: matched,
      modifiedCount: 0,
      deletedCount: res.rowCount || 0,
      document: { ...filter },
      elapsedMs: Date.now() - started,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Execute a single insert/update/delete against the admin Connect DB. */
export async function runBaWriteOp(
  cfg: BaDbConnectionResolved,
  req: BaDbWriteRequest,
): Promise<BaDbWriteResult> {
  const op = String(req.op || "").toLowerCase() as BaDbWriteOp;
  if (op !== "insert" && op !== "update" && op !== "delete") {
    throw new Error("op must be insert | update | delete");
  }
  const normalized: BaDbWriteRequest = { ...req, op };
  if (cfg.dialect === "mongodb") return writeMongo(cfg, normalized);
  if (cfg.dialect === "mysql") return writeMysql(cfg, normalized);
  if (cfg.dialect === "postgres") return writePostgres(cfg, normalized);
  throw new Error(`Unsupported dialect: ${cfg.dialect}`);
}
