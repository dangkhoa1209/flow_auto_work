/**
 * Proactive access-token refresh on tab wake / online.
 * Prevents a storm of 401s after long idle from racing into a false logout.
 *
 * Mobile: Home → other app → return often freezes JS mid-refresh (bfcache).
 * Recover stuck locks, debounce wake refresh, never treat storage blips as logout.
 */
import { refreshAccessToken } from "./client";
import { recoverAuthRefreshLocks } from "./http";
import {
  getAccessExpiresAt,
  getAccessToken,
  getRefreshToken,
} from "./tokenStorage";

const REFRESH_SKEW_MS = 120_000; // refresh when <2 min left
const PERIODIC_MS = 30 * 60 * 1000; // safety net while tab visible
const WAKE_DEBOUNCE_MS = 400;

let bound = false;
let inFlight = false;
let inFlightStartedAt = 0;
let periodicTimer: ReturnType<typeof setInterval> | undefined;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenAt = 0;

const IN_FLIGHT_STALE_MS = 45_000;

function recoverKeepAliveLock(): void {
  if (!inFlight) return;
  if (inFlightStartedAt && Date.now() - inFlightStartedAt < IN_FLIGHT_STALE_MS) {
    return;
  }
  inFlight = false;
  inFlightStartedAt = 0;
}

async function refreshIfNeeded(): Promise<void> {
  recoverKeepAliveLock();
  recoverAuthRefreshLocks();
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
  inFlightStartedAt = Date.now();
  try {
    await refreshAccessToken();
  } catch {
    /* refreshAccessToken already soft-fails network; hard 401 clears session */
  } finally {
    inFlight = false;
    inFlightStartedAt = 0;
  }
}

function scheduleWakeRefresh(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }
  if (wakeTimer) clearTimeout(wakeTimer);
  // Brief delay so mobile network / localStorage settle after Home resume.
  wakeTimer = setTimeout(() => {
    wakeTimer = undefined;
    void refreshIfNeeded();
  }, WAKE_DEBOUNCE_MS);
}

function onVisibilityChange(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  scheduleWakeRefresh();
}

function onPageshow(ev: PageTransitionEvent): void {
  // bfcache restore — locks may be stale from a frozen in-flight refresh.
  if (ev.persisted || (hiddenAt && Date.now() - hiddenAt > 1_000)) {
    recoverKeepAliveLock();
    recoverAuthRefreshLocks();
  }
  scheduleWakeRefresh();
}

function onOnline(): void {
  scheduleWakeRefresh();
}

/** Bind once from app bootstrap (safe to call repeatedly). */
export function bindSessionKeepAlive(): void {
  if (bound || typeof window === "undefined") return;
  bound = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onOnline);
  window.addEventListener("pageshow", onPageshow);
  periodicTimer = setInterval(() => {
    if (document.visibilityState === "visible") void refreshIfNeeded();
  }, PERIODIC_MS);
}

export function unbindSessionKeepAlive(): void {
  if (!bound || typeof window === "undefined") return;
  bound = false;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("online", onOnline);
  window.removeEventListener("pageshow", onPageshow);
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
  }
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = undefined;
  }
}
