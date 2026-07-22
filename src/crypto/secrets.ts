import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { getConfig } from "../config.js";

const PREFIX = "v1";

/** Derive a stable 32-byte AES key from FLOW_SECRETS_KEY. */
export function getSecretsKey(): Buffer {
  const raw = getConfig().FLOW_SECRETS_KEY?.trim();
  if (!raw) {
    throw new Error(
      "FLOW_SECRETS_KEY is required to encrypt user secrets (GitLab/Cursor tokens)",
    );
  }
  // Prefer raw 64-char hex
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  // Otherwise scrypt from passphrase (salt fixed per app — key still secret via passphrase)
  return scryptSync(raw, "flow-auto-work-secrets-v1", 32);
}

/** Encrypt plaintext → `v1.<iv>.<tag>.<cipher>` (base64url). */
export function encryptSecret(plaintext: string): string {
  const text = plaintext.trim();
  if (!text) throw new Error("Cannot encrypt empty secret");
  const key = getSecretsKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

/** Decrypt value produced by encryptSecret. */
export function decryptSecret(payload: string): string {
  const parts = payload.trim().split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("Invalid encrypted secret format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = getSecretsKey();
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

export function isEncryptedSecret(value: string | undefined | null): boolean {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 4 && parts[0] === PREFIX;
}
