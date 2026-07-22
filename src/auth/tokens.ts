import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getSecretsKey } from "../crypto/secrets.js";

export const ACCESS_TTL_SEC = 10 * 60; // 10 minutes
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

export type AccessClaims = {
  typ: "access";
  sub: string;
  iat: number;
  exp: number;
};

export type RefreshClaims = {
  typ: "refresh";
  sub: string;
  jti: string;
  iat: number;
  exp: number;
};

function b64url(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function signPayload(payload: object): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", getSecretsKey())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifySigned<T extends { exp: number; typ: string }>(
  token: string,
  typ: T["typ"],
): T {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid token format");
  const [body, sig] = parts;
  const expected = createHmac("sha256", getSecretsKey())
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid token signature");
  }
  let claims: T;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error("Invalid token payload");
  }
  if (claims.typ !== typ) throw new Error("Wrong token type");
  if (typeof claims.exp !== "number" || Date.now() / 1000 >= claims.exp) {
    throw new Error("Token expired");
  }
  return claims;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function issueAccessToken(username: string): {
  token: string;
  expiresIn: number;
  expiresAt: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = {
    typ: "access",
    sub: username.trim().replace(/^@/, "").toLowerCase(),
    iat: now,
    exp: now + ACCESS_TTL_SEC,
  };
  return {
    token: signPayload(claims),
    expiresIn: ACCESS_TTL_SEC,
    expiresAt: claims.exp * 1000,
  };
}

export function issueRefreshToken(username: string): {
  token: string;
  jti: string;
  expiresAt: Date;
} {
  const now = Math.floor(Date.now() / 1000);
  const jti = randomBytes(16).toString("hex");
  const claims: RefreshClaims = {
    typ: "refresh",
    sub: username.trim().replace(/^@/, "").toLowerCase(),
    jti,
    iat: now,
    exp: now + REFRESH_TTL_SEC,
  };
  return {
    token: signPayload(claims),
    jti,
    expiresAt: new Date(claims.exp * 1000),
  };
}

export function verifyAccessToken(token: string): AccessClaims {
  return verifySigned<AccessClaims>(token, "access");
}

export function verifyRefreshToken(token: string): RefreshClaims {
  return verifySigned<RefreshClaims>(token, "refresh");
}

export function newTokenPair(username: string) {
  const access = issueAccessToken(username);
  const refresh = issueRefreshToken(username);
  return { access, refresh };
}
