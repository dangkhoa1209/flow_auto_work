import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { WriteStream } from "node:fs";
import { logger } from "../../logger.js";
import { getRepoRoot } from "../../repoRoot.js";
import type { SyncDbLogStream } from "./types.js";

const MAX_REPLAY_BYTES = 512 * 1024;

export function resolveSyncDbLogDir(): string {
  const dir = process.env.SYNC_DB_LOG_DIR?.trim();
  return dir
    ? path.resolve(dir)
    : path.resolve(getRepoRoot(), "data", "sync-db-logs");
}

export function logPathForSyncDb(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveSyncDbLogDir(), `${safe}.log`);
}

export async function ensureSyncDbLogDir(): Promise<string> {
  const dir = resolveSyncDbLogDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export type SyncDbLogWriter = {
  readonly filePath: string;
  write(stream: SyncDbLogStream, text: string, at?: string): void;
  close(): Promise<void>;
};

export async function openSyncDbLog(jobId: string): Promise<SyncDbLogWriter> {
  await ensureSyncDbLogDir();
  const filePath = logPathForSyncDb(jobId);
  const stream: WriteStream = createWriteStream(filePath, { flags: "a" });
  let closed = false;

  const write = (kind: SyncDbLogStream, text: string, at?: string) => {
    if (closed) return;
    const ts = at || new Date().toISOString();
    const line = text.endsWith("\n") ? text : `${text}\n`;
    try {
      stream.write(`[${ts}] [${kind}] ${line}`);
    } catch (err) {
      logger.warn("Sync DB log write failed", { jobId, err: String(err) });
    }
  };

  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      stream.end(() => resolve());
    });

  return { filePath, write, close };
}

export async function readSyncDbLogTail(
  filePath: string,
  maxBytes = MAX_REPLAY_BYTES,
): Promise<string> {
  if (!filePath || !existsSync(filePath)) return "";
  try {
    const info = await stat(filePath);
    if (info.size <= maxBytes) {
      return await readFile(filePath, "utf8");
    }
    const { createReadStream } = await import("node:fs");
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const rs = createReadStream(filePath, {
        start: Math.max(0, info.size - maxBytes),
        encoding: "utf8",
      });
      rs.on("data", (c) =>
        chunks.push(typeof c === "string" ? Buffer.from(c) : c),
      );
      rs.on("error", reject);
      rs.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  } catch (err) {
    logger.warn("Sync DB log read failed", { filePath, err: String(err) });
    return "";
  }
}

export function parseLogLines(text: string): Array<{
  at: string;
  stream: SyncDbLogStream;
  text: string;
}> {
  const out: Array<{ at: string; stream: SyncDbLogStream; text: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(
      /^\[([^\]]+)\]\s+\[(stdout|stderr|system)\]\s?(.*)$/,
    );
    if (m) {
      out.push({
        at: m[1],
        stream: m[2] as SyncDbLogStream,
        text: m[3] ?? "",
      });
    } else {
      out.push({
        at: new Date().toISOString(),
        stream: "system",
        text: raw,
      });
    }
  }
  return out;
}
