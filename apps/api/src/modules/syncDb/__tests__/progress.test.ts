import { describe, expect, it } from "vitest";
import {
  isSkippedSyncCollection,
  partitionSyncCollections,
} from "../excludedCollections.js";
import { createProgressTracker, parseToolLine } from "../progress.js";
import {
  assertSafeRestoreTarget,
  assertSourceUserReadonly,
} from "../safety.js";
import type { SyncDbSystemConfigResolved } from "../types.js";
import type { BaDbConnectionResolved } from "../../../workspace/baStore.js";

describe("syncDb excluded collections", () => {
  it("skips logs case-insensitively", () => {
    expect(isSkippedSyncCollection("logs")).toBe(true);
    expect(isSkippedSyncCollection("Logs")).toBe(true);
    expect(isSkippedSyncCollection("users")).toBe(false);
    expect(isSkippedSyncCollection("activity_logs")).toBe(false);
  });

  it("partitions list for progress totals", () => {
    const { included, skipped } = partitionSyncCollections([
      "users",
      "logs",
      "orders",
    ]);
    expect(included).toEqual(["users", "orders"]);
    expect(skipped).toEqual(["logs"]);
  });
});

describe("syncDb progress parse", () => {
  it("parses dump/restore collection lines (legacy + Database Tools 100.x backticks)", () => {
    expect(parseToolLine("writing YKK.users to archive on stdout", "YKK")).toEqual({
      kind: "start",
      name: "users",
      phaseHint: "dump",
    });
    expect(
      parseToolLine(
        "2026-09-09T10:24:26.374+0700\twriting `YKK.attendance_records` to `archive on stdout`",
        "YKK",
      ),
    ).toEqual({
      kind: "start",
      name: "attendance_records",
      phaseHint: "dump",
    });
    expect(parseToolLine("done dumping YKK.users (12 documents)", "YKK")).toEqual({
      kind: "done",
      name: "users",
      phaseHint: "dump",
    });
    expect(
      parseToolLine(
        "done dumping `YKK.attendance_record_raws` (945801 documents)",
        "YKK",
      ),
    ).toEqual({
      kind: "done",
      name: "attendance_record_raws",
      phaseHint: "dump",
    });
    expect(
      parseToolLine("restoring to YKK.orders from archive", "YKK"),
    ).toEqual({
      kind: "start",
      name: "orders",
      phaseHint: "restore",
    });
    expect(
      parseToolLine(
        "restoring `YKK.timekeepings` from `archive on stdin`",
        "YKK",
      ),
    ).toEqual({
      kind: "start",
      name: "timekeepings",
      phaseHint: "restore",
    });
    expect(
      parseToolLine(
        "finished restoring `YKK.attendance_record_raws` (945801 documents, 0 failures)",
        "YKK",
      ),
    ).toEqual({
      kind: "done",
      name: "attendance_record_raws",
      phaseHint: "restore",
    });
  });

  it("parses progress-bar lines for current collection", () => {
    expect(
      parseToolLine(
        "[######..................]          YKK.timekeepings    247709/976144  (25.4%)",
        "YKK",
      ),
    ).toEqual({
      kind: "start",
      name: "timekeepings",
    });
  });

  it("tracks done/total across lines", () => {
    const t = createProgressTracker("YKK");
    t.setTotal(2, ["users", "orders"]);
    t.setPhase("dump");
    t.applyLine("writing `YKK.users` to `archive on stdout`");
    expect(t.snapshot().current).toContain("users");
    t.applyLine("done dumping `YKK.users` (1 documents)");
    expect(t.snapshot().dumpDone).toBe(1);
    expect(t.snapshot().done).toBe(1);
    // Pipe expects dump+restore → total = 2 * collections
    expect(t.snapshot().total).toBe(4);
  });

  it("keeps dump progress when restore stderr interleaves", () => {
    const t = createProgressTracker("YKK");
    t.setTotal(3, ["a", "b", "c"]);
    t.setPhase("dump");
    t.applyLine("writing `YKK.a` to `archive on stdout`");
    t.applyLine("done dumping `YKK.a` (1 documents)");
    t.applyLine("writing `YKK.b` to `archive on stdout`");
    t.applyLine("done dumping `YKK.b` (1 documents)");
    expect(t.snapshot().dumpDone).toBe(2);
    expect(t.snapshot().done).toBe(2);

    // Restore starts while dump still running — must NOT reset dump counters.
    t.applyLine("restoring `YKK.a` from `archive on stdin`");
    t.applyLine(
      "finished restoring `YKK.a` (1 documents, 0 failures)",
    );
    expect(t.snapshot().dumpDone).toBe(2);
    expect(t.snapshot().restoreDone).toBe(1);
    expect(t.snapshot().done).toBe(3);
    expect(t.snapshot().phase).toBe("restore");

    t.applyLine("done dumping `YKK.c` (1 documents)");
    expect(t.snapshot().dumpDone).toBe(3);
    expect(t.snapshot().restoreDone).toBe(1);
    expect(t.snapshot().done).toBe(4);
    expect(t.snapshot().total).toBe(6);
  });

  it("uses stream hint for progress bars so current is not empty", () => {
    const t = createProgressTracker("YKK");
    t.setTotal(2, ["timekeepings", "users"]);
    t.setPhase("dump");
    t.applyLine(
      "[####....................]            YKK.timekeepings    202840/976144  (20.8%)",
      "dump",
    );
    expect(t.snapshot().current).toContain("timekeepings");
    expect(t.snapshot().dumpDone).toBe(0);
    t.applyLine(
      "done dumping `YKK.timekeepings` (976144 documents)",
      "dump",
    );
    expect(t.snapshot().dumpDone).toBe(1);
    expect(t.snapshot().current).not.toContain("timekeepings");
  });
});

describe("assertSafeRestoreTarget", () => {
  const source: SyncDbSystemConfigResolved = {
    enabled: true,
    sshHost: "aihr.example.com",
    sshPort: 22,
    sshUsername: "ops",
    sshPassword: "x",
    sshPrivateKey: "",
    tunnelLocalPort: 27019,
    remoteMongoHost: "localhost",
    remoteMongoPort: 27017,
    sourceUsername: "ro",
    sourcePassword: "y",
    sourceAuthSource: "admin",
    dropTarget: true,
    timeoutSec: 3600,
  };

  it("allows loopback target", () => {
    const target: BaDbConnectionResolved = {
      dialect: "mongodb",
      host: "127.0.0.1",
      port: 27017,
      database: "YKK",
      username: "",
      password: "",
      ssl: false,
    };
    expect(() => assertSafeRestoreTarget(target, source)).not.toThrow();
  });

  it("blocks restore to SSH/live host", () => {
    const target: BaDbConnectionResolved = {
      dialect: "mongodb",
      host: "aihr.example.com",
      port: 27017,
      database: "YKK",
      username: "",
      password: "",
      ssl: false,
    };
    expect(() => assertSafeRestoreTarget(target, source)).toThrow(/live/);
  });

  it("blocks restore to non-loopback private IP even if not SSH host", () => {
    const target: BaDbConnectionResolved = {
      dialect: "mongodb",
      host: "10.0.0.50",
      port: 27017,
      database: "YKK",
      username: "",
      password: "",
      ssl: false,
    };
    expect(() => assertSafeRestoreTarget(target, source)).toThrow(/loopback/);
  });

  it("blocks restore when target matches remote Mongo host", () => {
    const src = {
      ...source,
      remoteMongoHost: "mongo-live.internal",
    };
    const target: BaDbConnectionResolved = {
      dialect: "mongodb",
      host: "mongo-live.internal",
      port: 27017,
      database: "YKK",
      username: "",
      password: "",
      ssl: false,
    };
    expect(() => assertSafeRestoreTarget(target, src)).toThrow(/live|loopback/);
  });

  it("blocks restore to tunnel port on loopback", () => {
    const target: BaDbConnectionResolved = {
      dialect: "mongodb",
      host: "127.0.0.1",
      port: 27019,
      database: "YKK",
      username: "",
      password: "",
      ssl: false,
    };
    expect(() => assertSafeRestoreTarget(target, source)).toThrow(/tunnel/);
  });
});

describe("assertSourceUserReadonly", () => {
  it("allows read-only privileges", () => {
    expect(() =>
      assertSourceUserReadonly(
        {
          authInfo: {
            authenticatedUserRoles: [{ role: "read", db: "YKK" }],
            authenticatedUserPrivileges: [
              {
                resource: { db: "YKK", collection: "" },
                actions: ["find", "listCollections", "listIndexes"],
              },
            ],
          },
        },
        "YKK",
      ),
    ).not.toThrow();
  });

  it("blocks readWrite role", () => {
    expect(() =>
      assertSourceUserReadonly(
        {
          authInfo: {
            authenticatedUserRoles: [{ role: "readWrite", db: "YKK" }],
            authenticatedUserPrivileges: [],
          },
        },
        "YKK",
      ),
    ).toThrow(/read-only/);
  });

  it("blocks insert privilege on target db", () => {
    expect(() =>
      assertSourceUserReadonly(
        {
          authInfo: {
            authenticatedUserRoles: [{ role: "custom", db: "admin" }],
            authenticatedUserPrivileges: [
              {
                resource: { db: "YKK", collection: "" },
                actions: ["find", "insert"],
              },
            ],
          },
        },
        "YKK",
      ),
    ).toThrow(/write/);
  });

  it("allows backup-style insert on config.settings only", () => {
    expect(() =>
      assertSourceUserReadonly(
        {
          authInfo: {
            authenticatedUserRoles: [{ role: "backup", db: "admin" }],
            authenticatedUserPrivileges: [
              {
                resource: { db: "config", collection: "settings" },
                actions: ["insert", "update", "find"],
              },
              {
                resource: { db: "YKK", collection: "" },
                actions: ["find", "listCollections"],
              },
            ],
          },
        },
        "YKK",
      ),
    ).not.toThrow();
  });
});
