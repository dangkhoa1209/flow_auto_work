import { describe, expect, it } from "vitest";
import { createProgressTracker, parseToolLine } from "../progress.js";
import {
  assertSafeRestoreTarget,
  assertSourceUserReadonly,
} from "../safety.js";
import type { SyncDbSystemConfigResolved } from "../types.js";
import type { BaDbConnectionResolved } from "../../../workspace/baStore.js";

describe("syncDb progress parse", () => {
  it("parses dump/restore collection lines", () => {
    expect(parseToolLine("writing YKK.users to archive on stdout", "YKK")).toEqual({
      kind: "start",
      name: "users",
      phaseHint: "dump",
    });
    expect(parseToolLine("done dumping YKK.users (12 documents)", "YKK")).toEqual({
      kind: "done",
      name: "users",
      phaseHint: "dump",
    });
    expect(
      parseToolLine("restoring to YKK.orders from archive", "YKK"),
    ).toEqual({
      kind: "start",
      name: "orders",
      phaseHint: "restore",
    });
  });

  it("tracks done/total across lines", () => {
    const t = createProgressTracker("YKK");
    t.setTotal(2, ["users", "orders"]);
    t.setPhase("dump");
    t.applyLine("writing YKK.users to archive on stdout");
    expect(t.snapshot().current).toContain("users");
    t.applyLine("done dumping YKK.users (1 documents)");
    expect(t.snapshot().done).toBe(1);
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
