/**
 * Spawn a local PTY in the project repo cwd.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import { spawn, type IPty } from "node-pty";
import { logger } from "../../logger.js";

export type PtySession = {
  pty: IPty;
  cwd: string;
  touch: () => void;
  lastActiveAt: number;
};

function resolveShell(): string {
  const fromEnv = (process.env.SHELL || "").trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (process.platform === "win32") return "powershell.exe";
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "/bin/sh";
}

export function spawnRepoPty(opts: {
  cwd: string;
  cols?: number;
  rows?: number;
}): PtySession {
  const shell = resolveShell();
  const cols = Math.max(20, opts.cols ?? 120);
  const rows = Math.max(8, opts.rows ?? 32);
  const session: PtySession = {
    pty: null as unknown as IPty,
    cwd: opts.cwd,
    lastActiveAt: Date.now(),
    touch() {
      session.lastActiveAt = Date.now();
    },
  };

  const term = spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FLOW_WORKBENCH_TERMINAL: "1",
    } as Record<string, string>,
  });
  session.pty = term;

  logger.info("Workbench PTY spawned", {
    shell,
    cwd: opts.cwd,
    pid: term.pid,
    platform: os.platform(),
  });

  return session;
}
