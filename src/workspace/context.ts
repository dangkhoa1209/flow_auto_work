import { resolveRuntimeContext } from "./resolve.js";
import { runWithRuntimeContext } from "./runtime.js";

/** Run handler inside decrypted user/project runtime context. */
export async function withWorkspaceContext<T>(
  username: string,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = await resolveRuntimeContext({
    gitlabUsername: username,
    projectId,
    requireLocalClone: true,
  });
  return runWithRuntimeContext(ctx, fn);
}
