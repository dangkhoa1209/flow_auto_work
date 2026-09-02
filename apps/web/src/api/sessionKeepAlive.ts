/**
 * Proactive access-token refresh on tab wake / online.
 * Prevents a storm of 401s after long idle from racing into a false logout.
 */
import { refreshAccessToken } from "./client";
import {
  getAccessExpiresAt,
  getAccessToken,
  getRefreshToken,
} from "./tokenStorage";

const REFRESH_SKEW_MS = 120_000; // refresh when <2 min left
const PERIODIC_MS = 30 * 60 * 1000; // safety net while tab visible

let bound = false;
let inFlight = false;
let periodicTimer: ReturnType<typeof setInterval> | undefined;

async function refreshIfNeeded(): Promise<void> {
  if (inFlight) return;
  if (!getRefreshToken()) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }

  const access = getAccessToken();
  const exp = getAccessExpiresAt();
  const needsRefresh =
    !access ||
    (exp != null && exp < Date.now() + REFRESH_SKEW_MS) ||
    (access && exp == null);

  if (!needsRefresh) return;

  inFlight = true;
  try {
    await refreshAccessToken();
  } catch {
    /* refreshAccessToken already soft-fails network; hard 401 clears session */
  } finally {
    inFlight = false;
  }
}

function onWake() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }
  void refreshIfNeeded();
}

/** Bind once from app bootstrap (safe to call repeatedly). */
export function bindSessionKeepAlive(): void {
  if (bound || typeof window === "undefined") return;
  bound = true;
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("online", onWake);
  window.addEventListener("pageshow", onWake);
  periodicTimer = setInterval(() => {
    if (document.visibilityState === "visible") void refreshIfNeeded();
  }, PERIODIC_MS);
}

export function unbindSessionKeepAlive(): void {
  if (!bound || typeof window === "undefined") return;
  bound = false;
  document.removeEventListener("visibilitychange", onWake);
  window.removeEventListener("online", onWake);
  window.removeEventListener("pageshow", onWake);
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = undefined;
  }
}
