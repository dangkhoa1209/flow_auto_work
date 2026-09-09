import type { SyncDbPhase, SyncDbProgress } from "./types.js";

/**
 * Parse mongodump / mongorestore verbose lines for collection progress.
 * Patterns are best-effort across tool versions — not a public API.
 *
 * Database Tools 100.x wraps namespaces / archive paths in backticks:
 *   writing `DB.coll` to `archive on stdout`
 *   done dumping `DB.coll` (N documents)
 *   restoring `DB.coll` from `archive on stdin`
 *   finished restoring `DB.coll` (N documents, 0 failures)
 * Legacy (no backticks) is still accepted.
 */
export function parseToolLine(
  line: string,
  dbName: string,
): { kind: "start" | "done"; name: string; phaseHint?: "dump" | "restore" } | null {
  const text = line.trim();
  if (!text) return null;

  // mongodump: writing [`]DB.coll[`] to [`]archive…
  let m = text.match(/\bwriting\s+`?([^\s`]+)`?\s+to\s+`?archive\b/i);
  if (m) {
    return { kind: "start", name: stripDb(m[1], dbName), phaseHint: "dump" };
  }
  m = text.match(/\bdone dumping\s+`?([^\s`(]+)`?/i);
  if (m) {
    return { kind: "done", name: stripDb(m[1], dbName), phaseHint: "dump" };
  }

  // mongorestore: restoring [to ][`]DB.coll[`] from [`]archive…
  m = text.match(/\brestoring\s+(?:to\s+)?`?([^\s`]+)`?\s+from\s+`?archive\b/i);
  if (m) {
    return { kind: "start", name: stripDb(m[1], dbName), phaseHint: "restore" };
  }
  m = text.match(/\bfinished restoring\s+`?([^\s`(]+)`?/i);
  if (m) {
    return { kind: "done", name: stripDb(m[1], dbName), phaseHint: "restore" };
  }

  // Progress bar (either tool): [####....]  DB.coll  123/456  (27.0%)
  // Phase comes from which child stderr (streamHint in applyLine).
  m = text.match(/\[[#.\s]+\]\s+(\S+)\s+\d+\/\d+/);
  if (m) {
    return { kind: "start", name: stripDb(m[1], dbName) };
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

/**
 * Pipeline mongodump | mongorestore interleaves stderr from both tools.
 * Track dump/restore separately and NEVER reset one when the other emits —
 * otherwise UI flickers 1/N ↔ 2/N then jumps to N/N on success.
 *
 * Display `done/total` spans both phases: total = collections * 2,
 * done = dumpFinished + restoreFinished (smooth climb through the pipe).
 */
export function createProgressTracker(dbName: string): ProgressTracker {
  let phase: SyncDbPhase = "queued";
  /** Collection count from listCollections (one phase). */
  let collections = 0;
  const finishedDump = new Set<string>();
  const finishedRestore = new Set<string>();
  const currentDump = new Set<string>();
  const currentRestore = new Set<string>();
  const known = new Set<string>();
  let sawDump = false;
  let sawRestore = false;

  const snap = (): SyncDbProgress => {
    const dumpDone = finishedDump.size;
    const restoreDone = finishedRestore.size;
    const base = Math.max(collections, known.size);
    // Archive pipe always runs dump + restore; count both so done climbs 0→2N.
    const inPipe =
      phase === "dump" ||
      phase === "restore" ||
      phase === "done" ||
      sawDump ||
      sawRestore;
    const phaseCount = inPipe ? 2 : 1;
    const total = Math.max(base * phaseCount, dumpDone + restoreDone);
    const showRestore =
      phase === "restore" || (sawRestore && (currentRestore.size > 0 || restoreDone > 0));
    const current = showRestore ? [...currentRestore] : [...currentDump];
    // While both run in the pipe, prefer showing dump currents if restore empty,
    // else merge a short preview so header is not stuck on "…".
    const merged =
      current.length > 0
        ? current
        : showRestore
          ? [...currentDump]
          : [...currentRestore];
    return {
      phase,
      total,
      done: dumpDone + restoreDone,
      collections: base || collections,
      dumpDone,
      restoreDone,
      current: merged.slice(0, 8),
      dbName,
    };
  };

  return {
    setPhase(p) {
      phase = p;
      // Do not clear finished* — pipeline stderr is interleaved; clearing
      // caused done to snap back to 0/1 and look "stuck" until success.
      if (p === "dump") {
        currentDump.clear();
        sawDump = true;
      } else if (p === "restore") {
        currentRestore.clear();
        sawRestore = true;
      } else if (p === "done" || p === "failed") {
        currentDump.clear();
        currentRestore.clear();
      }
      return snap();
    },
    setTotal(t, names) {
      collections = Math.max(0, t);
      if (names) {
        for (const n of names) known.add(n);
      }
      return snap();
    },
    applyLine(line, streamHint) {
      const ev = parseToolLine(line, dbName);
      if (!ev) return snap();

      const hint: "dump" | "restore" | undefined =
        ev.phaseHint ??
        (streamHint === "dump" || streamHint === "restore"
          ? streamHint
          : undefined);
      // Progress bars without a stream hint cannot be classified — skip.
      if (!hint) return snap();

      if (hint === "dump") {
        sawDump = true;
        if (phase !== "done" && phase !== "failed" && !sawRestore) {
          phase = "dump";
        }
      } else {
        sawRestore = true;
        if (phase !== "done" && phase !== "failed") {
          phase = "restore";
        }
      }

      const name = ev.name;
      if (!name || name === "*") return snap();
      known.add(name);

      const isDump = hint === "dump";
      const finished = isDump ? finishedDump : finishedRestore;
      const current = isDump ? currentDump : currentRestore;

      if (ev.kind === "start") {
        // Do not revive a collection already counted done in this phase.
        if (!finished.has(name)) current.add(name);
      } else {
        current.delete(name);
        finished.add(name);
      }
      return snap();
    },
    snapshot: snap,
  };
}
