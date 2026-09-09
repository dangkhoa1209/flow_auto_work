import type { SyncDbPhase, SyncDbProgress } from "./types.js";

/**
 * Parse mongodump / mongorestore verbose lines for collection progress.
 * Patterns are best-effort across tool versions — not a public API.
 */
export function parseToolLine(
  line: string,
  dbName: string,
): { kind: "start" | "done"; name: string; phaseHint?: "dump" | "restore" } | null {
  const text = line.trim();
  if (!text) return null;

  // mongodump: "writing DB.coll to archive on stdout"
  // mongodump: "done dumping DB.coll (N documents)"
  let m = text.match(
    /\bwriting\s+([^\s]+)\s+to\s+archive/i,
  );
  if (m) {
    return { kind: "start", name: stripDb(m[1], dbName), phaseHint: "dump" };
  }
  m = text.match(/\bdone dumping\s+([^\s(]+)/i);
  if (m) {
    return { kind: "done", name: stripDb(m[1], dbName), phaseHint: "dump" };
  }

  // mongorestore: "restoring to DB.coll from archive"
  // mongorestore: "finished restoring DB.coll (N documents)"
  m = text.match(/\brestoring\s+(?:to\s+)?([^\s]+)\s+from\s+archive/i);
  if (m) {
    return { kind: "start", name: stripDb(m[1], dbName), phaseHint: "restore" };
  }
  m = text.match(/\bfinished restoring\s+([^\s(]+)/i);
  if (m) {
    return { kind: "done", name: stripDb(m[1], dbName), phaseHint: "restore" };
  }

  return null;
}

function stripDb(ns: string, dbName: string): string {
  const raw = ns.replace(/[`'"]/g, "").trim();
  const prefix = `${dbName}.`;
  if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  const idx = raw.indexOf(".");
  if (idx > 0) return raw.slice(idx + 1);
  return raw;
}

export type ProgressTracker = {
  applyLine(line: string, phaseHint?: SyncDbPhase): SyncDbProgress;
  setPhase(phase: SyncDbPhase): SyncDbProgress;
  setTotal(total: number, names?: string[]): SyncDbProgress;
  snapshot(): SyncDbProgress;
};

export function createProgressTracker(dbName: string): ProgressTracker {
  let phase: SyncDbPhase = "queued";
  let total = 0;
  let done = 0;
  const finished = new Set<string>();
  const current = new Set<string>();
  const known = new Set<string>();

  const snap = (): SyncDbProgress => ({
    phase,
    total,
    done,
    current: [...current].slice(0, 8),
    dbName,
  });

  return {
    setPhase(p) {
      phase = p;
      if (p === "dump" || p === "restore") {
        current.clear();
        // dump→restore: reset done for restore phase display
        if (p === "restore") {
          done = 0;
          finished.clear();
        }
      }
      return snap();
    },
    setTotal(t, names) {
      total = Math.max(0, t);
      if (names) {
        for (const n of names) known.add(n);
      }
      return snap();
    },
    applyLine(line, phaseHint) {
      const ev = parseToolLine(line, dbName);
      if (!ev) return snap();
      if (ev.phaseHint === "dump" && phase !== "dump") {
        phase = "dump";
        done = 0;
        finished.clear();
        current.clear();
      }
      if (ev.phaseHint === "restore" && phase !== "restore") {
        phase = "restore";
        done = 0;
        finished.clear();
        current.clear();
      }
      if (phaseHint === "dump" || phaseHint === "restore") {
        phase = phaseHint;
      }
      const name = ev.name;
      if (!name || name === "*") return snap();
      known.add(name);
      if (ev.kind === "start") {
        current.add(name);
      } else {
        current.delete(name);
        if (!finished.has(name)) {
          finished.add(name);
          done = finished.size;
        }
      }
      if (total < known.size) total = known.size;
      return snap();
    },
    snapshot: snap,
  };
}
