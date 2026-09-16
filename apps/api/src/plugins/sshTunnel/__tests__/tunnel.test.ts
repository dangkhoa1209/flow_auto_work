import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSshLocalForwardCmdline,
  resolveTunnelLocalPort,
  tunnelPortFallbackCandidates,
} from "../tunnel.js";

describe("isSshLocalForwardCmdline", () => {
  it("matches ssh / sshpass -L <port>:", () => {
    expect(
      isSshLocalForwardCmdline(
        "ssh -L 27019:127.0.0.1:27017 user@host -N",
        27019,
      ),
    ).toBe(true);
    expect(
      isSshLocalForwardCmdline(
        "sshpass -e ssh -L27019:localhost:27017 user@host -N",
        27019,
      ),
    ).toBe(true);
    expect(
      isSshLocalForwardCmdline(
        ["sshpass", "-e", "ssh", "-L", "27019:db:27017", "u@h", "-N"].join(
          "\0",
        ),
        27019,
      ),
    ).toBe(true);
  });

  it("rejects other ports or non-ssh processes", () => {
    expect(
      isSshLocalForwardCmdline(
        "ssh -L 27018:127.0.0.1:27017 user@host -N",
        27019,
      ),
    ).toBe(false);
    expect(
      isSshLocalForwardCmdline("mongod --port 27019", 27019),
    ).toBe(false);
    expect(isSshLocalForwardCmdline("", 27019)).toBe(false);
    expect(isSshLocalForwardCmdline("ssh -L 27019:h:1", 0)).toBe(false);
  });
});

describe("tunnelPortFallbackCandidates", () => {
  it("starts at preferred then increments", () => {
    expect(tunnelPortFallbackCandidates(27019, 3)).toEqual([
      27019, 27020, 27021, 27022,
    ]);
  });

  it("rejects invalid preferred ports", () => {
    expect(tunnelPortFallbackCandidates(0)).toEqual([]);
    expect(tunnelPortFallbackCandidates(70000)).toEqual([]);
  });
});

describe("resolveTunnelLocalPort", () => {
  const holders: Server[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* */
      }
    }
    await Promise.all(
      holders.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
  });

  async function holdPort(port: number): Promise<void> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    holders.push(server);
  }

  /** Child process listens so last-resort kill can free preferred without killing vitest. */
  async function holdPortInChild(port: number): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("net").createServer().listen(${port},"127.0.0.1",()=>process.stdout.write("ok"))`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`child did not bind ${port}`)),
        5000,
      );
      child.stdout?.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited early code=${code}`));
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return child;
  }

  it("falls back to the next free port when preferred is busy", async () => {
    const base = 37100 + Math.floor(Math.random() * 400);
    await holdPort(base);
    const chosen = await resolveTunnelLocalPort(base, "test", "busy", 4);
    expect(chosen).toBe(base + 1);
  });

  it("force-kills preferred listeners when the whole fallback window is busy", async () => {
    const base = 37500 + Math.floor(Math.random() * 400);
    const maxOffset = 3;
    await holdPortInChild(base);
    for (let i = 1; i <= maxOffset; i++) {
      await holdPort(base + i);
    }
    const chosen = await resolveTunnelLocalPort(base, "test", "busy", maxOffset);
    expect(chosen).toBe(base);
  }, 15_000);

  it("throws when preferred is held by this process and the fallback window is busy", async () => {
    const base = 37900 + Math.floor(Math.random() * 400);
    const maxOffset = 2;
    for (let i = 0; i <= maxOffset; i++) {
      await holdPort(base + i);
    }
    await expect(
      resolveTunnelLocalPort(base, "test", "busy", maxOffset),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("could not free"),
    });
  }, 15_000);
});
