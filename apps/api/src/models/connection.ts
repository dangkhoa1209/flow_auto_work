import { MongoClient, type Db } from "mongodb";
import { buildMongoUri, getConfig } from "../config.js";

let client: MongoClient | null = null;
let db: Db | null = null;

/** Shared Mongo connection for all models. */
export async function connectMongo(): Promise<Db> {
  if (db) return db;
  const cfg = getConfig();
  const uri = buildMongoUri(cfg);
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(cfg.DB_DATABASE);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("MongoDB not connected");
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export async function mongoPing(): Promise<boolean> {
  try {
    const database = await connectMongo();
    await database.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
