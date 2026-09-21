/**
 * Warm Cursor local workspace (rules / skills / MCP / ignore) before first send.
 * Failures are ignored — send() rebuilds on demand.
 */
import { createAgentPlatform, type AgentOptions } from "@cursor/sdk";
import { logger } from "../../logger.js";

const releaseByCwd = new Map<string, () => Promise<void>>();
const inflightByCwd = new Map<string, Promise<void>>();

function cwdKey(opts: AgentOptions): string {
  const cwd = opts.local?.cwd?.trim() || process.cwd();
  return cwd;
}

/**
 * Prewarm once per cwd. Safe to call from clone completion and before Agent.create.
 * Holds the release fn for process lifetime (refcounted by SDK).
 */
export async function prewarmLocalWorkspaceBestEffort(
  options: AgentOptions,
): Promise<void> {
  const key = cwdKey(options);
  if (releaseByCwd.has(key)) return;
  const pending = inflightByCwd.get(key);
  if (pending) {
    await pending;
    return;
  }

  const work = (async () => {
    try {
      const platform = await createAgentPlatform();
      const release = await platform.prewarmLocalWorkspace(options);
      const prev = releaseByCwd.get(key);
      releaseByCwd.set(key, release);
      if (prev) {
        try {
          await prev();
        } catch {
          /* ignore */
        }
      }
      logger.info("Cursor workspace prewarmed", { cwd: key });
    } catch (err) {
      logger.warn("Cursor workspace prewarm skipped", {
        cwd: key,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflightByCwd.delete(key);
    }
  })();

  inflightByCwd.set(key, work);
  await work;
}

/** Fire-and-forget prewarm after clone (uses system Cursor key when present). */
export function scheduleCloneWorkspacePrewarm(cwd: string): void {
  const path = cwd.trim();
  if (!path) return;
  void (async () => {
    try {
      const { resolveSystemCursorApiKey } = await import(
        "../../workspace/baStore.js"
      );
      const apiKey = (await resolveSystemCursorApiKey())?.trim();
      if (!apiKey) return;
      await prewarmLocalWorkspaceBestEffort({
        apiKey,
        model: { id: "auto" },
        local: { cwd: path },
      });
    } catch {
      /* no system key / prewarm failed — first send pays the cost */
    }
  })();
}
