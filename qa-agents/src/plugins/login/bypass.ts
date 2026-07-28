import { logger } from "../../../../src/logger.js";
import type { QaProjectConfig } from "../../types.js";
import { extractJsonPath } from "./json-path.js";

export { extractJsonPath } from "./json-path.js";

export type LoginBypassResult = {
  token: string;
  durationMs: number;
};

/**
 * Fast API login against staging — extracts JWT via configured JSON path.
 * Never logs credentials or the raw token.
 */
export async function loginBypass(
  config: QaProjectConfig,
  credentials: { username: string; password: string },
): Promise<LoginBypassResult> {
  const base = config.stagingBaseUrl.replace(/\/$/, "");
  const path = config.loginPath.startsWith("/")
    ? config.loginPath
    : `/${config.loginPath}`;
  const url = `${base}${path}`;
  const body: Record<string, string> = {
    [config.requestBodyKeys.username]: credentials.username,
    [config.requestBodyKeys.password]: credentials.password,
  };
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const durationMs = Date.now() - started;
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.warn("QA login bypass: non-JSON response", {
      status: res.status,
      durationMs,
    });
    throw new Error(`Login failed (${res.status}): response is not JSON`);
  }
  if (!res.ok) {
    logger.warn("QA login bypass failed", { status: res.status, durationMs });
    throw new Error(`Login failed (${res.status})`);
  }
  const token = extractJsonPath(json, config.tokenJsonPath);
  if (!token) {
    throw new Error(
      `Login OK but token not found at path "${config.tokenJsonPath}"`,
    );
  }
  logger.info("QA login bypass OK", { durationMs });
  return { token, durationMs };
}
