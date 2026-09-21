import {
  buildCloneUrl,
  gitHttpAuthEnvFromCloneUrl,
  stripCloneUrlCredentials,
} from "../../workspace/clone.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { git } from "./exec.js";

/**
 * HTTPS remote with the runtime PAT (project setup / login), same scheme as clone.
 * Avoids `origin` (often unauthenticated HTTPS) and local SSH keys.
 */
export function resolvePatRemoteUrl(): string {
  const rt = getRuntimeContext();
  const token = rt?.gitlabToken?.trim();
  const gitlabPath = rt?.gitlabPath?.trim();
  if (!rt || !token || !gitlabPath) {
    throw new Error(
      "No remote PAT in runtime — cannot talk to git remote (clone/login with token first)",
    );
  }
  const host = rt.gitlabHost || "https://gitlab.com";
  return buildCloneUrl({
    provider: rt.gitProvider,
    host,
    token,
    path: gitlabPath,
  });
}

/** Public URL for git argv + PAT in env (never put the token in argv). */
export function resolvePatGitAuth(): {
  publicUrl: string;
  authEnv: NodeJS.ProcessEnv;
} {
  const patUrl = resolvePatRemoteUrl();
  return {
    publicUrl: stripCloneUrlCredentials(patUrl),
    authEnv: gitHttpAuthEnvFromCloneUrl(patUrl),
  };
}

/**
 * `git fetch <public-https-url> …` authenticated with the runtime PAT.
 * Pass a refspec such as `+refs/heads/foo:refs/remotes/origin/foo` to update
 * `origin/*` tracking refs.
 */
export async function fetchWithPat(
  repoPath: string,
  fetchArgs: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { publicUrl, authEnv } = resolvePatGitAuth();
  return git(repoPath, ["fetch", publicUrl, ...fetchArgs], undefined, authEnv);
}
