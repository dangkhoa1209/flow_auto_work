import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { redactGitCredentials } from "../plugins/git/redact.js";
import {
  normalizeGitlabHost,
  type GitProvider,
  normalizeGitProvider,
} from "./types.js";

function stripHost(host: string): string {
  return normalizeGitlabHost(host).replace(/^https?:\/\//i, "");
}

function cleanRepoPath(repoPath: string): string {
  return repoPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

/** `https://oauth2:TOKEN@host/group/repo.git` (GitLab) */
export function buildOauthCloneUrl(
  gitlabHost: string,
  token: string,
  gitlabPath: string,
): string {
  const host = stripHost(gitlabHost);
  const repoPath = cleanRepoPath(gitlabPath);
  const encToken = encodeURIComponent(token);
  return `https://oauth2:${encToken}@${host}/${repoPath}.git`;
}

/** `https://x-access-token:TOKEN@host/owner/repo.git` (GitHub classic PAT) */
export function buildGithubCloneUrl(
  githubHost: string,
  token: string,
  repoPath: string,
): string {
  const host = stripHost(githubHost || "https://github.com");
  const clean = cleanRepoPath(repoPath);
  const encToken = encodeURIComponent(token);
  return `https://x-access-token:${encToken}@${host}/${clean}.git`;
}

export function buildCloneUrl(opts: {
  provider?: GitProvider | string | null;
  host: string;
  token: string;
  path: string;
}): string {
  const provider = normalizeGitProvider(opts.provider);
  if (provider === "github") {
    return buildGithubCloneUrl(opts.host, opts.token, opts.path);
  }
  return buildOauthCloneUrl(opts.host, opts.token, opts.path);
}

/**
 * Public HTTPS URL without embedded user:token.
 * Prefer this for `git push|fetch|clone` argv so Node `execFile` errors
 * (`Command failed: git …`) never contain the PAT.
 */
export function stripCloneUrlCredentials(cloneUrl: string): string {
  return cloneUrl.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1");
}

/**
 * Auth via GIT_CONFIG_* env (not argv). Node error.message includes cmd/args,
 * not env — so PAT stays out of /work "Chat lỗi:" even before redact.
 */
export function gitHttpAuthEnvFromCloneUrl(
  cloneUrl: string,
): NodeJS.ProcessEnv {
  const m = cloneUrl.match(
    /^(https?):\/\/([^:/@\s]+):([^@/\s]+)@([^/\s]+)/i,
  );
  if (!m) return { GIT_TERMINAL_PROMPT: "0" };
  const scheme = m[1].toLowerCase();
  const user = decodeURIComponent(m[2]);
  const token = decodeURIComponent(m[3]);
  const host = m[4];
  const basic = Buffer.from(`${user}:${token}`, "utf8").toString("base64");
  const origin = `${scheme}://${host}`;
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
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
    const publicUrl = stripCloneUrlCredentials(opts.cloneUrl);
    const authEnv = gitHttpAuthEnvFromCloneUrl(opts.cloneUrl);
    const child = spawn(
      "git",
      ["clone", "--", publicUrl, opts.localPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...authEnv },
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
      const safe = redactGitCredentials(stderr);
      reject(new Error(`git clone failed (exit ${code}): ${safe.slice(-800)}`));
    });
  });
}
