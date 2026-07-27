import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { getRuntimeContext } from "../../workspace/runtime.js";

const execFileAsync = promisify(execFile);

export type GitIdentity = {
  name: string;
  email: string;
};

/** PAT sessions have no global git config — derive identity from logged-in GitLab user. */
export function resolveGitIdentity(): GitIdentity {
  const rt = getRuntimeContext();
  const username = rt?.gitlabUsername?.trim().replace(/^@/, "") || "flow-auto-work";
  return {
    name: username,
    email: `${username}@users.noreply.gitlab`,
  };
}

export function gitExecEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { name, email } = resolveGitIdentity();
  return {
    ...process.env,
    ...extra,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

export function gitExecOptions(
  repoPath: string,
  maxBuffer = 10 * 1024 * 1024,
): ExecFileOptions {
  return {
    cwd: repoPath,
    maxBuffer,
    encoding: "utf8",
    env: gitExecEnv(),
  };
}

export async function git(
  repoPath: string,
  args: string[],
  maxBuffer?: number,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(
    "git",
    args,
    gitExecOptions(repoPath, maxBuffer ?? 10 * 1024 * 1024),
  );
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

/** Same as git() but returns stdout only (throws on failure). */
export async function gitStdout(
  repoPath: string,
  args: string[],
  maxBuffer?: number,
): Promise<string> {
  const { stdout } = await git(repoPath, args, maxBuffer);
  return stdout;
}
