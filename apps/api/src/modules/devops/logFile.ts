import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { WriteStream } from "node:fs";
import { logger } from "../../logger.js";
import { getRepoRoot } from "../../repoRoot.js";
import type { BuildLogStream } from "./types.js";

const MAX_REPLAY_BYTES = 512 * 1024;

export function resolveBuildLogDir(): string {
  const dir = process.env.BUILD_LOG_DIR?.trim();
  return dir
    ? path.resolve(dir)
    : path.resolve(getRepoRoot(), "data", "build-logs");
}

export function logPathForBuild(buildId: string): string {
  const safe = buildId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveBuildLogDir(), `${safe}.log`);
}

export async function ensureBuildLogDir(): Promise<string> {
  const dir = resolveBuildLogDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export type BuildLogWriter = {
  readonly filePath: string;
  write(stream: BuildLogStream, text: string, at?: string): void;
  close(): Promise<void>;
};

export async function openBuildLog(buildId: string): Promise<BuildLogWriter> {
  await ensureBuildLogDir();
  const filePath = logPathForBuild(buildId);
  const stream: WriteStream = createWriteStream(filePath, { flags: "a" });
  let closed = false;

  const write = (kind: BuildLogStream, text: string, at?: string) => {
    if (closed) return;
    const ts = at || new Date().toISOString();
    const line = text.endsWith("\n") ? text : `${text}\n`;
    try {
      stream.write(`[${ts}] [${kind}] ${line}`);
    } catch (err) {
      logger.warn("Build log write failed", { buildId, err: String(err) });
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

export async function readBuildLogTail(
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
      rs.on("data", (c) => chunks.push(Buffer.from(c)));
      rs.on("error", reject);
      rs.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  } catch (err) {
    logger.warn("Could not read build log", { filePath, err: String(err) });
    return "";
  }
}

export function parseLogLines(raw: string): Array<{
  at: string;
  stream: BuildLogStream;
  text: string;
}> {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const out: Array<{ at: string; stream: BuildLogStream; text: string }> = [];
  for (const line of lines) {
    const m = line.match(
      /^\[([^\]]+)\] \[(stdout|stderr|system)\] (.*)$/,
    );
    if (m) {
      out.push({
        at: m[1],
        stream: m[2] as BuildLogStream,
        text: m[3],
      });
    } else {
      out.push({
        at: new Date().toISOString(),
        stream: "system",
        text: line,
      });
    }
  }
  return out;
}
