import { getConfig } from "../../config.js";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import type { JobGoogleAuth, JobRecord } from "../../types.js";
import { logger } from "../../logger.js";

export const GOOGLE_SHEETS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly";

/** Needed to read uploaded Excel (.xlsx) files that are not native Sheets. */
export const GOOGLE_DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";

export const GOOGLE_OAUTH_SCOPES = [
  GOOGLE_SHEETS_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
].join(" ");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function googleCreds(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const c = getConfig();
  const clientId = (c.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (c.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const redirectUri = (c.GOOGLE_OAUTH_REDIRECT_URI ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth is not configured (GOOGLE_OAUTH_CLIENT_ID / SECRET / REDIRECT_URI)",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function isGoogleOAuthConfigured(): boolean {
  return getConfig().googleOAuthConfigured;
}

/** Build Google consent URL (offline access + force consent for refresh token). */
export function buildGoogleAuthUrl(state: string): string {
  const { clientId, redirectUri } = googleCreds();
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_OAUTH_SCOPES);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

async function postToken(
  body: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(
      json.error_description || json.error || `token exchange HTTP ${res.status}`,
    );
  }
  return json;
}

export async function exchangeGoogleCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
  email?: string;
}> {
  const { clientId, clientSecret, redirectUri } = googleCreds();
  const tokens = await postToken({
    code: code.trim(),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!tokens.access_token) {
    throw new Error("Google token response missing access_token");
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token — revoke app access and try again with prompt=consent",
    );
  }
  let email: string | undefined;
  try {
    const ures = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (ures.ok) {
      const u = (await ures.json()) as { email?: string };
      email = u.email?.trim() || undefined;
    }
  } catch (err) {
    logger.warn("Google userinfo fetch failed", { err: String(err) });
  }
  const scopes = (tokens.scope || GOOGLE_OAUTH_SCOPES)
    .split(/\s+/)
    .filter(Boolean);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: Number(tokens.expires_in) || 3600,
    scopes,
    email,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn: number;
  scopes?: string[];
}> {
  const { clientId, clientSecret } = googleCreds();
  const tokens = await postToken({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  if (!tokens.access_token) {
    throw new Error("Google refresh response missing access_token");
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: Number(tokens.expires_in) || 3600,
    scopes: tokens.scope?.split(/\s+/).filter(Boolean),
  };
}

export function buildEncryptedGoogleAuth(input: {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  scopes: string[];
  email?: string;
  sheetIds?: string[];
  previous?: JobGoogleAuth;
}): JobGoogleAuth {
  const expiresAt = new Date(
    Date.now() + Math.max(60, input.expiresIn - 60) * 1000,
  ).toISOString();
  const sheetIds = [
    ...new Set([
      ...(input.previous?.sheetIds ?? []),
      ...(input.sheetIds ?? []),
    ]),
  ].filter(Boolean);
  return {
    email: input.email || input.previous?.email,
    refreshTokenEnc: encryptSecret(input.refreshToken),
    accessTokenEnc: encryptSecret(input.accessToken),
    accessExpiresAt: expiresAt,
    scopes: input.scopes.length
      ? input.scopes
      : input.previous?.scopes?.length
        ? input.previous.scopes
        : GOOGLE_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
    sheetIds,
    authorizedAt: input.previous?.authorizedAt || new Date().toISOString(),
    revokedAt: undefined,
  };
}

/**
 * Return a valid access token from stored auth, refreshing when near expiry.
 * Does not persist — caller must save `auth` if refreshed.
 */
export async function ensureGoogleAccessTokenFromAuth(
  auth: JobGoogleAuth | undefined | null,
): Promise<
  | { ok: true; accessToken: string; auth: JobGoogleAuth; refreshed: boolean }
  | { ok: false; reason: "missing" | "refresh_failed" }
> {
  if (!auth?.refreshTokenEnc || auth.revokedAt) {
    return { ok: false, reason: "missing" };
  }
  try {
    const expiresAt = auth.accessExpiresAt
      ? Date.parse(auth.accessExpiresAt)
      : 0;
    const skewMs = 90_000;
    if (
      auth.accessTokenEnc &&
      Number.isFinite(expiresAt) &&
      expiresAt - skewMs > Date.now()
    ) {
      return {
        ok: true,
        accessToken: decryptSecret(auth.accessTokenEnc),
        auth,
        refreshed: false,
      };
    }
    const refreshToken = decryptSecret(auth.refreshTokenEnc);
    const refreshed = await refreshAccessToken(refreshToken);
    const next = buildEncryptedGoogleAuth({
      refreshToken,
      accessToken: refreshed.accessToken,
      expiresIn: refreshed.expiresIn,
      scopes: refreshed.scopes?.length ? refreshed.scopes : auth.scopes,
      email: auth.email,
      sheetIds: auth.sheetIds,
      previous: auth,
    });
    return {
      ok: true,
      accessToken: refreshed.accessToken,
      auth: next,
      refreshed: true,
    };
  } catch (err) {
    logger.warn("Google access token refresh failed", { err: String(err) });
    return { ok: false, reason: "refresh_failed" };
  }
}

/**
 * Return a valid access token for the job, refreshing when near expiry.
 * Clears googleAuth token fields (keeps email/sheetIds metadata cleared too) on failure → caller gates.
 */
export async function ensureJobGoogleAccessToken(
  job: JobRecord,
): Promise<
  | { ok: true; accessToken: string; auth: JobGoogleAuth }
  | { ok: false; reason: "missing" | "refresh_failed" }
> {
  const result = await ensureGoogleAccessTokenFromAuth(job.googleAuth);
  if (!result.ok) {
    logger.warn("Google access token refresh failed", {
      jobId: job.id,
      reason: result.reason,
    });
    return result;
  }
  if (result.refreshed) job.googleAuth = result.auth;
  return { ok: true, accessToken: result.accessToken, auth: result.auth };
}

/** Best-effort revoke at Google; always safe to clear local tokens after. */
export async function revokeGoogleToken(tokenPlain: string): Promise<void> {
  const t = tokenPlain.trim();
  if (!t) return;
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(t)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (err) {
    logger.warn("Google revoke request failed", { err: String(err) });
  }
}

/** UI-safe google auth (no ciphertext). */
export function publicGoogleAuthStatus(job: JobRecord): {
  configured: boolean;
  authorized: boolean;
  email?: string;
  sheetIds: string[];
  scopes: string[];
  authorizedAt?: string;
  revokedAt?: string;
  pendingSheetUrls: string[];
} {
  const auth = job.googleAuth;
  const authorized = Boolean(
    auth?.refreshTokenEnc && !auth.revokedAt,
  );
  return {
    configured: isGoogleOAuthConfigured(),
    authorized,
    email: auth?.email,
    sheetIds: auth?.sheetIds ?? [],
    scopes: auth?.scopes ?? [],
    authorizedAt: auth?.authorizedAt,
    revokedAt: auth?.revokedAt,
    pendingSheetUrls: job.pendingGoogleSheetUrls ?? [],
  };
}

/** Strip secrets before sending JobRecord to the browser. */
export function redactJobGoogleAuthForClient<T extends JobRecord>(
  job: T,
): T {
  if (!job.googleAuth) return job;
  const { email, scopes, sheetIds, authorizedAt, revokedAt } = job.googleAuth;
  return {
    ...job,
    googleAuth: {
      email,
      scopes: scopes ?? [],
      sheetIds: sheetIds ?? [],
      authorizedAt: authorizedAt || new Date(0).toISOString(),
      revokedAt,
      // Placeholders so type stays JobGoogleAuth — never real tokens
      refreshTokenEnc: "",
    },
  };
}
