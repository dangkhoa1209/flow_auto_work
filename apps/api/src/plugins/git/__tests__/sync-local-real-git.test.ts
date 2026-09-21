/**
 * Real-git integration: syncLocalToRemoteCommit fetch+reset pipeline.
 * Uses a local bare remote (file://) so we exercise git itself without GitLab network.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

const fetchWithPatMock = vi.fn();

vi.mock("../remote-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../remote-auth.js")>(
    "../remote-auth.js",
  );
  return {
    ...actual,
    fetchWithPat: (...args: unknown[]) => fetchWithPatMock(...args),
  };
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return String(stdout).trim();
}

describe("syncLocalToRemoteCommit (real git)", () => {
  let root = "";
  let bare = "";
  let work = "";
  let remoteSha = "";

  beforeAll(async () => {
    // Prefer workspace tmp (sandbox may block hooks under OS /tmp)
    const base = path.join(process.cwd(), "apps/api/.tmp-git-tests");
    await mkdir(base, { recursive: true });
    root = await mkdtemp(path.join(base, "flow-pat-sync-"));
    bare = path.join(root, "remote.git");
    work = path.join(root, "work");
    const seed = path.join(root, "seed");
    const emptyTemplate = path.join(root, "empty-template");
    await mkdir(emptyTemplate, { recursive: true });

    await git(root, ["-c", `init.templateDir=${emptyTemplate}`, "init", "--bare", bare]);
    await mkdir(seed, { recursive: true });
    await git(seed, ["-c", `init.templateDir=${emptyTemplate}`, "init", "-b", "uat"]);
    await git(seed, ["remote", "add", "origin", bare]);
    await writeFile(path.join(seed, "README.md"), "v1\n");
    await git(seed, ["add", "README.md"]);
    await git(seed, ["commit", "-m", "initial"]);
    await git(seed, ["push", "-u", "origin", "uat"]);

    // Second commit on remote tip (API-commit equivalent)
    await writeFile(path.join(seed, "README.md"), "v2 remote tip\n");
    await git(seed, ["add", "README.md"]);
    await git(seed, ["commit", "-m", "remote tip"]);
    await git(seed, ["push", "origin", "uat"]);
    remoteSha = await git(seed, ["rev-parse", "HEAD"]);

    // Stale local clone still on first commit
    await git(root, ["clone", "--branch", "uat", bare, work]);
    const parent = await git(seed, ["rev-parse", "HEAD~1"]);
    await git(work, ["reset", "--hard", parent]);
    const localHead = await git(work, ["rev-parse", "HEAD"]);
    expect(localHead).not.toBe(remoteSha);
  }, 30_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("pulls remote tip via fetchWithPat refspec and hard-resets local", async () => {
    fetchWithPatMock.mockImplementation(
      async (repoPath: string, fetchArgs: string[]) => {
        const { stdout, stderr } = await execFileAsync(
          "git",
          ["fetch", bare, ...fetchArgs],
          { cwd: repoPath, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        );
        return { stdout: String(stdout), stderr: String(stderr) };
      },
    );

    const { syncLocalToRemoteCommit } = await import("../changes-for-api.js");
    await syncLocalToRemoteCommit(work, "uat", remoteSha);

    const head = await git(work, ["rev-parse", "HEAD"]);
    expect(head).toBe(remoteSha);
    const body = await git(work, ["show", "HEAD:README.md"]);
    expect(body).toContain("v2 remote tip");
    expect(fetchWithPatMock).toHaveBeenCalledWith(work, [
      "+refs/heads/uat:refs/remotes/origin/uat",
    ]);
  });
});
