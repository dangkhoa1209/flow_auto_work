import { exec } from "node:child_process";
import { logger } from "../../logger.js";

export type VerifyResult = {
  ok: boolean;
  /** Combined stdout + stderr, tail-truncated */
  output: string;
  /** null when killed by timeout */
  exitCode: number | null;
  durationMs: number;
};

const MAX_OUTPUT_CHARS = 20_000;

/**
 * Run the project's verify command (typecheck / lint / build) in the repo.
 * Never throws — failures are returned so the caller can self-heal / report.
 */
export function runVerifyCommand(
  repoPath: string,
  command: string,
  opts?: { timeoutSec?: number },
): Promise<VerifyResult> {
  const timeoutMs = Math.max(10, opts?.timeoutSec ?? 300) * 1000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: repoPath,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CI: "1" },
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const output = `${stdout ?? ""}\n${stderr ?? ""}`
          .trim()
          .slice(-MAX_OUTPUT_CHARS);
        if (!err) {
          resolve({ ok: true, output, exitCode: 0, durationMs });
          return;
        }
        const exitCode =
          typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : null;
        logger.warn("Verify command failed", {
          command,
          exitCode,
          durationMs,
          killed: (err as { killed?: boolean }).killed,
        });
        resolve({ ok: false, output, exitCode, durationMs });
      },
    );
  });
}
