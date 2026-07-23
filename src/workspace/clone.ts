import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { normalizeGitlabHost } from "./types.js";

/** `https://oauth2:TOKEN@host/group/repo.git` */
export function buildOauthCloneUrl(
  gitlabHost: string,
  token: string,
  gitlabPath: string,
): string {
  const host = normalizeGitlabHost(gitlabHost).replace(/^https?:\/\//i, "");
  const repoPath = gitlabPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const encToken = encodeURIComponent(token);
  return `https://oauth2:${encToken}@${host}/${repoPath}.git`;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(localPath: string): Promise<boolean> {
  try {
    await access(path.join(localPath, ".git"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone into localPath (parent dirs created). Rejects if path already has .git.
 */
export function runGitClone(opts: {
  cloneUrl: string;
  localPath: string;
}): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      if (await isGitRepo(opts.localPath)) {
        resolve();
        return;
      }
      if (await pathExists(opts.localPath)) {
        reject(
          new Error(
            `localPath exists but is not a git repo: ${opts.localPath}`,
          ),
        );
        return;
      }
      await mkdir(path.dirname(opts.localPath), { recursive: true });
    } catch (err) {
      reject(err);
      return;
    }

    logger.info("git clone starting", { localPath: opts.localPath });
    const child = spawn(
      "git",
      ["clone", "--", opts.cloneUrl, opts.localPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    let stderr = "";
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        logger.info("git clone finished", { localPath: opts.localPath });
        resolve();
        return;
      }
      // Redact token if it leaked into stderr
      const safe = stderr.replace(/oauth2:[^@\s]+@/gi, "oauth2:***@");
      reject(new Error(`git clone failed (exit ${code}): ${safe.slice(-800)}`));
    });
  });
}
