import { randomBytes } from "node:crypto";

export type GoogleOAuthStatePayload = {
  /** Job OAuth — required when purpose=job */
  jobId?: string;
  /** After user OAuth, auto-continue this job (workbench). */
  continueJobId?: string;
  purpose: "job" | "ba";
  ownerUsername: string;
  nonce: string;
  createdAt: number;
  expiresAt: number;
};

const TTL_MS = 10 * 60 * 1000;
const store = new Map<string, GoogleOAuthStatePayload>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

/** Create a short-lived OAuth `state` bound to job + owner (Dev WorkBench). */
export function createGoogleOAuthState(input: {
  jobId: string;
  ownerUsername: string;
}): string {
  return createGoogleOAuthStateRaw({
    purpose: "job",
    jobId: input.jobId,
    ownerUsername: input.ownerUsername,
  });
}

/** User-level Google (Settings / BA) — optional job auto-continue after OAuth. */
export function createBaGoogleOAuthState(input: {
  ownerUsername: string;
  continueJobId?: string;
}): string {
  return createGoogleOAuthStateRaw({
    purpose: "ba",
    ownerUsername: input.ownerUsername,
    continueJobId: input.continueJobId,
  });
}

function createGoogleOAuthStateRaw(input: {
  purpose: "job" | "ba";
  jobId?: string;
  continueJobId?: string;
  ownerUsername: string;
}): string {
  prune();
  const state = randomBytes(24).toString("base64url");
  const now = Date.now();
  store.set(state, {
    purpose: input.purpose,
    jobId: input.jobId,
    continueJobId: input.continueJobId?.trim() || undefined,
    ownerUsername: input.ownerUsername.trim().toLowerCase(),
    nonce: randomBytes(8).toString("hex"),
    createdAt: now,
    expiresAt: now + TTL_MS,
  });
  return state;
}

/** Consume state (one-time). Returns null if missing/expired. */
export function consumeGoogleOAuthState(
  state: string,
): GoogleOAuthStatePayload | null {
  prune();
  const key = (state || "").trim();
  if (!key) return null;
  const row = store.get(key);
  store.delete(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) return null;
  // Backward compat: old states without purpose were job-only
  if (!row.purpose && row.jobId) {
    return { ...row, purpose: "job" };
  }
  return row;
}
