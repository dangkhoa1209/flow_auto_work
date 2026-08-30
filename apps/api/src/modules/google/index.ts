import { getConfig } from "../../config.js";
import { saveJob } from "../../job-store.js";
import { jobQueue } from "../../queue.js";
import {
  buildEncryptedGoogleAuth,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  isGoogleOAuthConfigured,
  publicGoogleAuthStatus,
  redactJobGoogleAuthForClient,
  revokeGoogleToken,
  ensureJobGoogleAccessToken,
  ensureGoogleAccessTokenFromAuth,
} from "../../plugins/google/oauth.js";
import {
  consumeGoogleOAuthState,
  createGoogleOAuthState,
  createBaGoogleOAuthState,
} from "../../plugins/google/oauth-state.js";
import {
  collectSheetRefsFromTexts,
  fetchSheetValuesForPrompt,
  formatSheetsPromptBlock,
  type GoogleSheetRef,
} from "../../plugins/google/sheets.js";
import { decryptSecret } from "../../plugins/crypto/secrets.js";
import { addChatMessage, listChatMessages } from "../../db/mongo.js";
import { requireJobRecord } from "../job/lifecycle.js";
import {
  resolveDevNotes,
  type JobGoogleAuth,
  type JobRecord,
} from "../../types.js";
import { AppError } from "../../utils/AppError.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { logger } from "../../logger.js";
import {
  clearUserGoogleAuth,
  getUserByUsername,
  setUserGoogleAuth,
} from "../../workspace/store.js";

export {
  isGoogleOAuthConfigured,
  publicGoogleAuthStatus,
  redactJobGoogleAuthForClient,
};

export async function getGoogleAuthUrlForJob(jobId: string): Promise<{
  authUrl: string;
  state: string;
  configured: boolean;
}> {
  if (!isGoogleOAuthConfigured()) {
    throw new AppError(
      "Google OAuth is not configured on the server",
      503,
      "google_oauth_unconfigured",
    );
  }
  const job = await requireJobRecord(jobId);
  const rt = getRuntimeContext();
  const owner =
    (rt?.gitlabUsername || job.ownerUsername || "").trim().toLowerCase();
  if (!owner) {
    throw new AppError("Missing workspace user for Google OAuth", 401);
  }
  if (
    job.ownerUsername &&
    job.ownerUsername.trim().toLowerCase() !== owner
  ) {
    throw new AppError("Job belongs to another user", 403);
  }
  const state = createGoogleOAuthState({
    jobId: job.id,
    ownerUsername: owner,
  });
  return {
    authUrl: buildGoogleAuthUrl(state),
    state,
    configured: true,
  };
}

export async function handleGoogleOAuthCallback(input: {
  code?: string;
  state?: string;
  error?: string;
}): Promise<{ ok: boolean; jobId?: string; message: string }> {
  if (input.error) {
    return {
      ok: false,
      message: `Google authorization denied: ${input.error}`,
    };
  }
  const code = (input.code || "").trim();
  const state = (input.state || "").trim();
  if (!code || !state) {
    return { ok: false, message: "Missing code or state" };
  }
  const payload = consumeGoogleOAuthState(state);
  if (!payload) {
    return {
      ok: false,
      message: "OAuth state expired or invalid — close and try Authorize again",
    };
  }

  // BA Settings OAuth (Docs / Sheets / Drive)
  if (payload.purpose === "ba") {
    try {
      const tokens = await exchangeGoogleCode(code);
      const auth = buildEncryptedGoogleAuth({
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        scopes: tokens.scopes,
        email: tokens.email,
        sheetIds: [],
      });
      await setUserGoogleAuth(payload.ownerUsername, auth);
      logger.info("Google OAuth saved for BA user", {
        user: payload.ownerUsername,
        email: tokens.email,
      });
      return {
        ok: true,
        message:
          "Google authorized for BA — Docs / Sheets / Excel trên Drive có thể đọc từ YC & chat.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("BA Google OAuth callback failed", { err: msg });
      return { ok: false, message: msg };
    }
  }

  const jobId = (payload.jobId || "").trim();
  if (!jobId) {
    return { ok: false, message: "OAuth state missing jobId" };
  }

  try {
    const tokens = await exchangeGoogleCode(code);
    const job = await requireJobRecord(jobId);
    const sheetIds = [
      ...new Set([
        ...(job.googleAuth?.sheetIds ?? []),
        ...(job.pendingGoogleSheetUrls
          ? collectSheetRefsFromTexts(job.pendingGoogleSheetUrls).map(
              (r) => r.spreadsheetId,
            )
          : []),
      ]),
    ];
    job.googleAuth = buildEncryptedGoogleAuth({
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      scopes: tokens.scopes,
      email: tokens.email,
      sheetIds,
      previous: job.googleAuth,
    });
    job.error = undefined;
    await saveJob(job, { source: "google-oauth-callback" });
    const emailLabel = tokens.email ? ` (${tokens.email})` : "";
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body:
        `✅ **Google Sheets đã ủy quyền**${emailLabel}.` +
        `\nĐang tiếp tục Run để đọc nội dung sheet vào context…`,
    });
    logger.info("Google OAuth saved on job", {
      jobId: job.id,
      email: tokens.email,
      sheetIds: sheetIds.length,
    });

    // Auto-continue — không cần nút Continue Run trên UI
    try {
      const cont = await continueJobAfterGoogleAuth(job.id);
      return {
        ok: true,
        jobId: job.id,
        message: cont.enqueued
          ? "Google authorized — Run đang tiếp tục"
          : `Google authorized — ${cont.reason || "job chưa enqueue được, thử Run lại"}`,
      };
    } catch (contErr) {
      logger.warn("Google OAuth auto-continue failed", {
        jobId: job.id,
        err: String(contErr),
      });
      return {
        ok: true,
        jobId: job.id,
        message:
          "Google authorized — chưa tiếp tục Run tự động, hãy bấm Run lại",
      };
    }
  } catch (err) {
    logger.warn("Google OAuth callback failed", { err: String(err) });
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const job = await requireJobRecord(jobId);
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "qa",
        body: `❌ **Google ủy quyền thất bại** — **chưa đọc** được Sheets.\n\`${msg}\``,
      });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      jobId,
      message: msg,
    };
  }
}

export async function getJobGoogleStatus(jobId: string) {
  const job = await requireJobRecord(jobId);
  return publicGoogleAuthStatus(job);
}

export async function revokeJobGoogleAuth(jobId: string): Promise<{
  ok: boolean;
  job: JobRecord;
}> {
  const job = await requireJobRecord(jobId);
  const auth = job.googleAuth;
  if (auth?.refreshTokenEnc) {
    try {
      await revokeGoogleToken(decryptSecret(auth.refreshTokenEnc));
    } catch {
      /* best effort */
    }
  } else if (auth?.accessTokenEnc) {
    try {
      await revokeGoogleToken(decryptSecret(auth.accessTokenEnc));
    } catch {
      /* best effort */
    }
  }
  job.googleAuth = undefined;
  job.pendingGoogleSheetUrls = undefined;
  await saveJob(job, { source: "google-revoke" });
  await addChatMessage({
    jobId: job.id,
    issueIid: job.issue.issueIid,
    role: "agent",
    kind: "qa",
    body: "🔌 Đã **Revoke** Google trên task này. Lần Run sau nếu còn link Sheets sẽ hỏi Authorize lại.",
  });
  return { ok: true, job: redactJobGoogleAuthForClient(job) };
}

/** After OAuth popup — re-enqueue the job to continue Run. */
export async function continueJobAfterGoogleAuth(jobId: string): Promise<{
  ok: boolean;
  enqueued: boolean;
  reason?: string;
  job: JobRecord;
}> {
  const job = await requireJobRecord(jobId);
  if (job.status === "awaiting_google_auth") {
    job.status = "draft";
    job.error = undefined;
    await saveJob(job);
  }
  if (job.workspaceProjectId) {
    const { requireProjectLocalClone } = await import(
      "../../workspace/resolve.js"
    );
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  const result = await jobQueue.enqueueExisting(jobId, {
    source: "google_auth_continue",
  });
  const fresh = await requireJobRecord(jobId);
  return {
    ok: result.enqueued,
    enqueued: result.enqueued,
    reason: result.reason,
    job: redactJobGoogleAuthForClient(fresh),
  };
}

export async function collectJobSheetRefs(
  job: JobRecord,
  chatBodies?: string[],
): Promise<GoogleSheetRef[]> {
  const texts: string[] = [
    job.issue?.description || "",
    resolveDevNotes(job),
    ...(job.pendingGoogleSheetUrls || []),
  ];
  if (chatBodies?.length) {
    texts.push(...chatBodies);
  } else {
    try {
      const rows = await listChatMessages({ jobId: job.id, limit: 40 });
      texts.push(...rows.map((m) => m.body || ""));
    } catch {
      /* ignore */
    }
  }
  return collectSheetRefsFromTexts(texts);
}

export async function detectJobGoogleSheets(jobId: string): Promise<{
  sheets: { spreadsheetId: string; url: string; gid?: string }[];
  includeIds: string[];
}> {
  const job = await requireJobRecord(jobId);
  const refs = await collectJobSheetRefs(job);
  const includeIds = [...new Set(job.googleSheetsIncludeIds ?? [])].filter(
    Boolean,
  );
  return {
    sheets: refs.map((r) => ({
      spreadsheetId: r.spreadsheetId,
      url: r.url,
      gid: r.gid,
    })),
    includeIds,
  };
}

export async function setJobGoogleSheetsInclude(
  jobId: string,
  spreadsheetIds: string[],
): Promise<{ ok: boolean; includeIds: string[]; job: JobRecord }> {
  const job = await requireJobRecord(jobId);
  const refs = await collectJobSheetRefs(job);
  const allowed = new Set(refs.map((r) => r.spreadsheetId));
  const includeIds = [
    ...new Set(
      (spreadsheetIds || [])
        .map((s) => String(s).trim())
        .filter((id) => id && allowed.has(id)),
    ),
  ];
  job.googleSheetsIncludeIds = includeIds.length ? includeIds : undefined;
  await saveJob(job, { source: "google-sheets-include" });
  return {
    ok: true,
    includeIds,
    job: redactJobGoogleAuthForClient(job),
  };
}

/**
 * Before agent Run: detect Sheets links → gate or fetch prompt block.
 * Only reads sheets the user opted into via `googleSheetsIncludeIds` (default: none).
 * Returns `{ gate: true }` when job was paused for OAuth.
 */
export async function prepareGoogleSheetsForJob(
  job: JobRecord,
  chatBodies?: string[],
): Promise<
  | { gate: true }
  | { gate: false; promptBlock: string }
> {
  const includeIds = new Set(
    (job.googleSheetsIncludeIds ?? []).map((s) => s.trim()).filter(Boolean),
  );
  if (!includeIds.size) {
    // Default: skip Sheets entirely (user must check boxes before Run)
    return { gate: false, promptBlock: "" };
  }

  const allRefs = await collectJobSheetRefs(job, chatBodies);
  const refs = allRefs.filter((r) => includeIds.has(r.spreadsheetId));
  if (!refs.length) {
    return { gate: false, promptBlock: "" };
  }

  if (!isGoogleOAuthConfigured()) {
    logger.warn(
      "Sheets URLs selected but Google OAuth not configured — skipping fetch",
      { jobId: job.id, count: refs.length },
    );
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body:
        `⚠️ Đã chọn **${refs.length}** Google Sheets/Excel nhưng server **chưa cấu hình** Google OAuth — **không đọc** được.\n` +
        `Thêm \`GOOGLE_OAUTH_CLIENT_ID\` / \`SECRET\` / \`REDIRECT_URI\` rồi Run lại.`,
    });
    return { gate: false, promptBlock: "" };
  }

  const tokenResult = await ensureJobGoogleAccessToken(job);
  if (!tokenResult.ok) {
    if (tokenResult.reason === "refresh_failed") {
      job.googleAuth = undefined;
    }
    job.status = "awaiting_google_auth";
    job.pendingGoogleSheetUrls = refs.map((r) => r.url);
    job.error = "Authorize Google to read linked Sheets";
    await saveJob(job, { source: "awaiting-google-auth" });
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body:
        tokenResult.reason === "refresh_failed"
          ? "⚠️ Google token hết hạn / refresh thất bại — **chưa đọc** được Sheets đã chọn.\nCấp quyền Google lại (popup) — hệ thống sẽ tự tiếp tục Run."
          : "🔗 Đã chọn đọc Google Sheets/Excel. Cấp quyền Google (readonly) — hệ thống sẽ tự tiếp tục Run sau khi ủy quyền.",
    });
    return { gate: true };
  }

  // Excel on Drive needs drive.readonly — old tokens may only have spreadsheets.readonly
  const scopes = job.googleAuth?.scopes ?? [];
  const hasDrive = scopes.some(
    (s) => s.includes("auth/drive.readonly") || s.includes("auth/drive"),
  );
  if (!hasDrive) {
    job.status = "awaiting_google_auth";
    job.pendingGoogleSheetUrls = refs.map((r) => r.url);
    job.error = "Re-authorize Google (Drive readonly) to read Excel files";
    await saveJob(job, { source: "awaiting-google-drive-scope" });
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body:
        "🔗 File Sheets/Excel trên Drive cần thêm quyền **Drive readonly**.\n" +
        "Bấm **Revoke** (nếu có) → cấp quyền Google lại (chấp nhận Drive + Sheets) — hệ thống tự tiếp tục Run.\n" +
        "Nhớ Enable **Google Drive API** trên Cloud project.",
    });
    return { gate: true };
  }

  const toFetch = refs;

  const blocks = [];
  for (const ref of toFetch) {
    blocks.push(
      await fetchSheetValuesForPrompt(tokenResult.accessToken, ref),
    );
  }

  const sheetIds = [
    ...new Set([
      ...(job.googleAuth?.sheetIds ?? []),
      ...toFetch.map((r) => r.spreadsheetId),
    ]),
  ];
  if (job.googleAuth) {
    job.googleAuth = { ...job.googleAuth, sheetIds };
  }
  job.pendingGoogleSheetUrls = undefined;
  await saveJob(job, { source: "google-sheets-fetch" });

  const okBlocks = blocks.filter((b) => !b.error);
  const failBlocks = blocks.filter((b) => b.error);
  const lines: string[] = [];
  if (okBlocks.length) {
    lines.push(
      `✅ **Đã đọc Sheets/Excel** (${okBlocks.length}/${blocks.length}) vào agent context:`,
    );
    for (const b of okBlocks) {
      const trunc = b.truncated ? " · truncated" : "";
      lines.push(`- ✓ **${b.title}** / ${b.sheetTitle}${trunc}`);
    }
  }
  if (failBlocks.length) {
    lines.push(
      okBlocks.length
        ? `\n❌ **Không đọc được** ${failBlocks.length} sheet:`
        : `❌ **Không đọc được** Google Sheets (${failBlocks.length}):`,
    );
    for (const b of failBlocks) {
      lines.push(`- ✗ \`${b.spreadsheetId}\` — ${b.error}`);
    }
  }
  if (!blocks.length) {
    lines.push("⚠️ Có link Sheets nhưng không fetch được mục tiêu nào.");
  }
  await addChatMessage({
    jobId: job.id,
    issueIid: job.issue.issueIid,
    role: "agent",
    kind: "qa",
    body: lines.join("\n"),
  });

  return {
    gate: false,
    promptBlock: formatSheetsPromptBlock(blocks),
  };
}

export function googleOAuthCallbackHtml(result: {
  ok: boolean;
  jobId?: string;
  message: string;
}): string {
  const cfg = getConfig();
  const origins = cfg.corsOrigins.join(" ");
  const payload = JSON.stringify({
    type: "flow-google-oauth",
    ok: result.ok,
    jobId: result.jobId || null,
    message: result.message,
  });
  const title = result.ok ? "Google authorized" : "Google auth failed";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; color: #111; background: #f7f7f5; }
    .box { max-width: 28rem; margin: 2rem auto; padding: 1.25rem 1.5rem; background: #fff; border: 1px solid #e5e5e0; border-radius: 8px; }
    .ok { color: #157347; } .err { color: #b42318; }
  </style>
</head>
<body>
  <div class="box">
    <p class="${result.ok ? "ok" : "err"}">${escapeHtml(result.message)}</p>
    <p style="color:#666;font-size:14px">You can close this window.</p>
  </div>
  <script>
    (function () {
      var payload = ${payload};
      try {
        if (window.opener && !window.opener.closed) {
          var origins = ${JSON.stringify(cfg.corsOrigins)};
          for (var i = 0; i < origins.length; i++) {
            try { window.opener.postMessage(payload, origins[i]); } catch (e) {}
          }
          try { window.opener.postMessage(payload, "*"); } catch (e2) {}
        }
      } catch (e) {}
      setTimeout(function () { try { window.close(); } catch (e3) {} }, 400);
    })();
  </script>
  <!-- allowed parents: ${escapeHtml(origins)} -->
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ── BA user Google (Docs / Sheets / Drive Excel) ── */

export async function getBaGoogleAuthUrl(username: string): Promise<{
  authUrl: string;
  state: string;
  configured: boolean;
}> {
  if (!isGoogleOAuthConfigured()) {
    throw new AppError(
      "Google OAuth is not configured on the server",
      503,
      "google_oauth_unconfigured",
    );
  }
  const owner = username.trim().toLowerCase().replace(/^@/, "");
  if (!owner) throw new AppError("Missing user", 401);
  const state = createBaGoogleOAuthState({ ownerUsername: owner });
  return {
    authUrl: buildGoogleAuthUrl(state),
    state,
    configured: true,
  };
}

export async function getBaGoogleStatus(username: string) {
  const user = await getUserByUsername(username);
  const auth = user?.googleAuth as JobGoogleAuth | undefined;
  const authorized = Boolean(auth?.refreshTokenEnc && !auth.revokedAt);
  return {
    configured: isGoogleOAuthConfigured(),
    authorized,
    email: authorized ? auth?.email : undefined,
    scopes: auth?.scopes ?? [],
    authorizedAt: auth?.authorizedAt,
  };
}

export async function revokeBaGoogleAuth(username: string) {
  const user = await getUserByUsername(username);
  const auth = user?.googleAuth as JobGoogleAuth | undefined;
  if (auth?.refreshTokenEnc) {
    try {
      await revokeGoogleToken(decryptSecret(auth.refreshTokenEnc));
    } catch {
      /* ignore */
    }
  }
  await clearUserGoogleAuth(username);
  return { ok: true };
}

/** Resolve BA user Google access token (refresh + persist if needed). */
export async function resolveBaUserGoogleAccessToken(
  username: string,
): Promise<string | null> {
  const user = await getUserByUsername(username);
  if (!user?.googleAuth) return null;
  const result = await ensureGoogleAccessTokenFromAuth(
    user.googleAuth as JobGoogleAuth,
  );
  if (!result.ok) return null;
  if (result.refreshed) {
    await setUserGoogleAuth(username, result.auth);
  }
  return result.accessToken;
}
