import type { Collection } from "mongodb";
import { connectMongo } from "../db/mongo.js";
import { hashToken } from "./tokens.js";

export type RefreshSessionDoc = {
  _id: string; // jti
  username: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt?: Date;
};

async function col(): Promise<Collection<RefreshSessionDoc>> {
  const db = await connectMongo();
  return db.collection<RefreshSessionDoc>("auth_refresh_sessions");
}

export async function ensureAuthIndexes(): Promise<void> {
  const c = await col();
  await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await c.createIndex({ username: 1, createdAt: -1 });
}

export async function saveRefreshSession(opts: {
  jti: string;
  username: string;
  rawToken: string;
  expiresAt: Date;
}): Promise<void> {
  const c = await col();
  await c.insertOne({
    _id: opts.jti,
    username: opts.username.trim().replace(/^@/, "").toLowerCase(),
    tokenHash: hashToken(opts.rawToken),
    expiresAt: opts.expiresAt,
    createdAt: new Date(),
  });
}

export async function consumeRefreshSession(opts: {
  jti: string;
  username: string;
  rawToken: string;
}): Promise<boolean> {
  const c = await col();
  const doc = await c.findOne({ _id: opts.jti });
  if (!doc || doc.revokedAt) return false;
  if (doc.expiresAt.getTime() <= Date.now()) return false;
  const user = opts.username.trim().replace(/^@/, "").toLowerCase();
  if (doc.username !== user) return false;
  if (doc.tokenHash !== hashToken(opts.rawToken)) return false;
  return true;
}

export async function revokeRefreshSession(jti: string): Promise<void> {
  const c = await col();
  await c.updateOne(
    { _id: jti },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllRefreshSessions(username: string): Promise<void> {
  const c = await col();
  const user = username.trim().replace(/^@/, "").toLowerCase();
  await c.updateMany(
    { username: user, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}
