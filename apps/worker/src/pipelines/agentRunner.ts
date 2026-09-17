/**
 * Ephemeral git worktree + graphify warm cache, then run Code Agent pipeline
 * via API processCodeAgentJob (secrets resolved on worker via withWorkspaceContext).
 *
 * When REPO_CACHE_ROOT is unset, skips worktree isolation and runs against the
 * project's configured localPath (compat path until cache is warm).
 */
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { CodeAgentJobData } from "@flow/shared";
import { processCodeAgentJob } from "../../../api/src/queue/processCodeJob.js";
import { prepareWorktreeGraphify } from "./graphifyWarmCache.js";
import { repoCacheRoot, worktreeRoot } from "../config.js";
import { runWithForcedRepoPath } from "../../../api/src/workspace/forceRepo.js";

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function runCursorAgentPipeline(
  data: CodeAgentJobData,
  onLog: (msg: string) => void | Promise<void>,
): Promise<{ status: string }> {
  const cacheRoot = repoCacheRoot();
  const baseDir = path.join(worktreeRoot(), `job-${data.jobId}`);
  const worktreeSource = path.join(baseDir, "source");
  const worktreeGraphify = path.join(baseDir, "graphify-out");

  let usedWorktree = false;

  try {
    if (cacheRoot) {
      // Expected layout: REPO_CACHE_ROOT/<slug>/source + sibling graphify-out
      const slug =
        data.projectId.replace(/[^a-zA-Z0-9._-]+/g, "_") || "project";
      const cacheProject = path.join(cacheRoot, slug);
      const cacheSource = path.join(cacheProject, "source");
      const cacheGraphify = path.join(cacheProject, "graphify-out");

      onLog("Creating isolated Git Worktree...");
      await mkdir(baseDir, { recursive: true });

      const baseBranch = data.baseBranch?.trim() || "HEAD";
      const workBranch =
        data.workBranch?.trim() || `flow-job-${data.jobId.slice(0, 8)}`;

      // Prefer worktree from cache source when it exists
      const add = await run(
        "git",
        [
          "worktree",
          "add",
          "-B",
          workBranch,
          worktreeSource,
          baseBranch,
        ],
        cacheSource,
      );
      if (add.code !== 0) {
        onLog(
          `git worktree add failed (${add.stderr || add.stdout}) — falling back to project localPath`,
        );
      } else {
        usedWorktree = true;
        const warm = await prepareWorktreeGraphify({
          cacheGraphifyOut: cacheGraphify,
          worktreeSource,
          worktreeGraphifyOut: worktreeGraphify,
          cacheSourcePath: cacheSource,
          onLog: (m) => void onLog(m),
        });
        if (!warm.ok) {
          onLog(
            "Graphify warm cache verify failed — agent may rebuild incrementally",
          );
        }
        return await runWithForcedRepoPath(worktreeSource, async () => {
          onLog("Executing Cursor SDK Agent pipeline...");
          return await processCodeAgentJob(data, {
            updateProgress: async (payload) => {
              if (payload.log || payload.text) {
                await onLog(String(payload.log || payload.text));
              }
            },
          });
        });
      }
    } else {
      onLog(
        "REPO_CACHE_ROOT unset — running against workspace localPath (no ephemeral worktree)",
      );
    }

    onLog("Executing Cursor SDK Agent pipeline...");
    return await processCodeAgentJob(data, {
      updateProgress: async (payload) => {
        if (payload.log || payload.text) {
          await onLog(String(payload.log || payload.text));
        }
      },
    });
  } finally {
    if (usedWorktree) {
      onLog("Cleaning up Git Worktree...");
      const cacheRoot2 = repoCacheRoot();
      const slug =
        data.projectId.replace(/[^a-zA-Z0-9._-]+/g, "_") || "project";
      const cacheSource = path.join(cacheRoot2, slug, "source");
      await run(
        "git",
        ["worktree", "remove", "--force", worktreeSource],
        cacheSource,
      ).catch(() => undefined);
      await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
