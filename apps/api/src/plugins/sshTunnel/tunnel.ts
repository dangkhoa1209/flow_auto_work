import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppError } from "../../utils/AppError.js";

export type SshTunnelParams = {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPassword: string;
  sshPrivateKey: string;
  tunnelLocalPort: number;
  /** Host:port as seen from the SSH server (often localhost:3306). */
  remoteHost: string;
  remotePort: number;
  /** Prefix for temp key files / error context (e.g. create-data, sync-db). */
  label?: string;
};

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function forceKillProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  killProcessTree(child, "SIGTERM");
  const pid = child.pid;
  if (!pid) return;
  setTimeout(() => {
    try {
      if (child.exitCode === null) {
        killProcessTree(child, "SIGKILL");
      }
    } catch {
      /* already gone */
    }
  }, 1500).unref?.();
}

function forceKillProcessTreeAndWait(
  child: ChildProcess,
  timeoutMs = 4000,
): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      resolve();
    };
    child.once("close", done);
    child.once("error", done);
    killProcessTree(child, "SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) killProcessTree(child, "SIGKILL");
    }, Math.min(1500, timeoutMs));
    const hardTimer = setTimeout(done, timeoutMs);
    killTimer.unref?.();
    hardTimer.unref?.();
  });
}

export async function assertTunnelPortFree(
  port: number,
  context = "Admin",
): Promise<void> {
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new AppError(
            `SSH tunnel port ${port} already in use — leftover tunnel from a prior run? Free the port or change tunnelLocalPort in ${context}`,
            409,
            "ssh_tunnel_port_busy",
          ),
        );
        return;
      }
      reject(err);
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(port, "127.0.0.1");
  });
}

export function formatSshTunnelExitMessage(
  code: number | null,
  stderrHint?: string,
  context = "Admin",
): string {
  const hint = (stderrHint || "").trim().replace(/\s+/g, " ").slice(0, 240);
  const lower = hint.toLowerCase();
  if (
    code === 5 ||
    lower.includes("permission denied") ||
    lower.includes("wrong password")
  ) {
    return (
      "SSH authentication failed (wrong password or user) — " +
      `fix SSH username/password in ${context}` +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (code === 6) {
    return (
      "SSH host key unknown — accept host once or pin known_hosts" +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (code === 7 || lower.includes("remote host identification has changed")) {
    return (
      "SSH host key changed (possible MITM) — verify host then update known_hosts" +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (code === 4) {
    return (
      "sshpass could not parse SSH prompt — check SSH user/host or use a private key" +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (lower.includes("connection refused") || lower.includes("no route to host")) {
    return (
      `SSH could not reach host — check sshHost/sshPort in ${context}` +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (
    lower.includes("name or service not known") ||
    lower.includes("could not resolve")
  ) {
    return (
      `SSH hostname could not be resolved — check sshHost in ${context}` +
      (hint ? ` [${hint}]` : "")
    );
  }
  return (
    `SSH tunnel exited early (code ${code})` + (hint ? `: ${hint}` : "")
  );
}

export function openSshTunnel(params: SshTunnelParams): {
  child: ChildProcess;
  keyFile: string | null;
  cleanup: () => Promise<void>;
} {
  const label = params.label || "ssh";
  const usePassword = Boolean(params.sshPassword && !params.sshPrivateKey);
  const args = [
    "-L",
    `${params.tunnelLocalPort}:${params.remoteHost}:${params.remotePort}`,
    `${params.sshUsername}@${params.sshHost}`,
    "-p",
    String(params.sshPort),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "TCPKeepAlive=yes",
    "-N",
  ];
  if (usePassword) {
    args.push("-o", "NumberOfPasswordPrompts=1");
  }

  let keyFile: string | null = null;
  const env = { ...process.env };
  delete env.SSHPASS;

  if (params.sshPrivateKey) {
    keyFile = path.join(
      tmpdir(),
      `flow-${label}-ssh-${process.pid}-${Date.now()}.pem`,
    );
    writeFileSync(keyFile, params.sshPrivateKey, { mode: 0o600 });
    args.unshift("-i", keyFile);
  }

  let child: ChildProcess;
  if (usePassword) {
    env.SSHPASS = params.sshPassword;
    child = spawn("sshpass", ["-e", "ssh", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } else {
    child = spawn("ssh", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  }

  const cleanupKey = () => {
    if (keyFile && existsSync(keyFile)) {
      try {
        unlinkSync(keyFile);
      } catch {
        /* */
      }
    }
  };

  const cleanup = async () => {
    try {
      await forceKillProcessTreeAndWait(child);
    } catch {
      forceKillProcessTree(child);
    }
    cleanupKey();
  };

  return { child, keyFile, cleanup };
}

export function waitTunnelReady(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  context = "Admin",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let stderrBuf = "";
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      reject(new Error(msg));
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve();
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    child.once("error", (err) =>
      fail(`SSH tunnel spawn failed: ${err.message}`),
    );
    child.once("exit", (code) => {
      if (!settled) {
        fail(formatSshTunnelExitMessage(code, stderrBuf, context));
      }
    });

    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        fail("SSH tunnel timeout — port not listening");
        return;
      }
      import("node:net")
        .then((net) => {
          const s = net.connect({ host: "127.0.0.1", port }, () => {
            s.end();
            ok();
          });
          s.on("error", () => {
            s.destroy();
          });
        })
        .catch(() => undefined);
    }, 200);
    timer.unref?.();
  });
}

/**
 * Open SSH local-forward, run `fn` against 127.0.0.1:tunnelLocalPort, then tear down.
 */
export async function withSshTunnel<T>(
  params: SshTunnelParams,
  fn: (local: { host: "127.0.0.1"; port: number }) => Promise<T>,
): Promise<T> {
  const context =
    params.label === "create-data"
      ? "Admin → Projects → Create Data"
      : params.label === "sync-db"
        ? "Admin → Sync DB"
        : "Admin";
  await assertTunnelPortFree(params.tunnelLocalPort, context);
  const tunnel = openSshTunnel(params);
  try {
    await waitTunnelReady(
      tunnel.child,
      params.tunnelLocalPort,
      20_000,
      context,
    );
    return await fn({ host: "127.0.0.1", port: params.tunnelLocalPort });
  } finally {
    await tunnel.cleanup().catch(() => undefined);
  }
}
