/**
 * After a new deploy, hashed Vite chunks (e.g. StatsView-XXXX.js) disappear.
 * Tabs still holding the old shell then fail dynamic import — reload once to
 * pick up the new index.html asset map (guarded against infinite reload loops).
 */

const STORAGE_KEY = "vite-chunk-reload-at";
const COOLDOWN_MS = 15_000;

export function isChunkLoadError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err ?? "");
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  );
}

function readLastReloadAt(): number {
  try {
    return Number(sessionStorage.getItem(STORAGE_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

function markReload(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

/** Soft-reload the page at most once per cooldown window. */
export function reloadOnChunkError(err?: unknown): boolean {
  if (err !== undefined && !isChunkLoadError(err)) return false;
  const last = readLastReloadAt();
  if (last && Date.now() - last < COOLDOWN_MS) return false;
  markReload();
  window.location.reload();
  return true;
}

export function bindVitePreloadErrorReload(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    reloadOnChunkError();
  });
}
