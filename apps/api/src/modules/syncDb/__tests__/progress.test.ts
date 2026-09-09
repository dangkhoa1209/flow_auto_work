import { describe, expect, it } from "vitest";
import { createProgressTracker, parseToolLine } from "../progress.js";
import { assertSafeRestoreTarget } from "../runner.js";
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
