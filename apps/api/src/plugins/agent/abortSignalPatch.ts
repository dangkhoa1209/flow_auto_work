import { setMaxListeners } from "node:events";

/**
 * Cursor SDK stacks many `abort` listeners on one AbortSignal per long-lived process.
 * Raise the limit on every new controller so Node does not warn after ~50 agent runs.
 */
export function patchAbortControllerMaxListeners(): void {
  const Native = globalThis.AbortController;
  if (!Native || (Native as { __fawPatched?: boolean }).__fawPatched) return;

  class PatchedAbortController extends Native {
    constructor() {
      super();
      try {
        setMaxListeners(200, this.signal);
      } catch {
        /* ignore — older runtimes */
      }
    }
  }

  (PatchedAbortController as { __fawPatched?: boolean }).__fawPatched = true;
  globalThis.AbortController = PatchedAbortController as typeof AbortController;
}

patchAbortControllerMaxListeners();
