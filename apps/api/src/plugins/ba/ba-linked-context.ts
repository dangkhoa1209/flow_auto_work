import { logger } from "../../logger.js";
import {
  loadBaGitlabTaskBlock,
  type BaIssueRef,
} from "../gitlab/ba-issue-read.js";
import {
  collectSheetRefsFromTexts,
  fetchSheetValuesForPrompt,
  formatSheetsPromptBlock,
  type GoogleSheetRef,
} from "../google/sheets.js";
import {
  collectGoogleDocRefsFromTexts,
  fetchGoogleDocForPrompt,
  formatDocsPromptBlock,
  type GoogleDocRef,
} from "../google/docs.js";
import { isGoogleOAuthConfigured } from "../google/oauth.js";

export type BaLinkedContextResult = {
  block: string;
  gitlabRefs: BaIssueRef[];
  sheetRefs: GoogleSheetRef[];
  docRefs: GoogleDocRef[];
  /** Có link Google nhưng chưa Authorize → BA cần mở Settings. */
  needsGoogleAuth: boolean;
  progressLabel?: string;
};

/**
 * Kéo ngữ cảnh từ YC / chat:
 * - GitLab `#id` / link issue
 * - Google Sheets / Excel trên Drive
 * - Google Docs / link Drive tài liệu
 */
export async function loadBaLinkedContext(opts: {
  gitlabHost: string;
  gitlabPath: string;
  gitlabToken: string | null;
  texts: string[];
  /** Access token Google (user BA đã Authorize). */
  googleAccessToken?: string | null;
}): Promise<BaLinkedContextResult> {
  const texts = opts.texts.filter((t) => t?.trim());
  const combined = texts.join("\n");

  const gitlab = await loadBaGitlabTaskBlock({
    gitlabHost: opts.gitlabHost,
    gitlabPath: opts.gitlabPath,
    token: opts.gitlabToken,
    texts,
  });

  const sheetRefs = collectSheetRefsFromTexts(texts);
  const docRefsAll = collectGoogleDocRefsFromTexts(texts);
  // Tránh trùng ID đã có trong sheetRefs (drive/open?id có thể trùng)
  const sheetIds = new Set(sheetRefs.map((r) => r.spreadsheetId));
  const docRefs = docRefsAll.filter((r) => !sheetIds.has(r.fileId));

  const hasGoogleLinks = sheetRefs.length > 0 || docRefs.length > 0;
  let needsGoogleAuth = false;
  const googleParts: string[] = [];
  const labels: string[] = [];

  if (gitlab.refs.length) {
    labels.push(`GitLab ${gitlab.refs.map((r) => `#${r.iid}`).join(", ")}`);
  }

  if (hasGoogleLinks) {
    if (!isGoogleOAuthConfigured()) {
      googleParts.push(
        `## Google Docs / Sheets (chỉ đọc)
Phát hiện ${sheetRefs.length + docRefs.length} link Google nhưng server **chưa cấu hình** Google OAuth (\`GOOGLE_OAUTH_*\`). Không đọc được — dán nội dung vào YC hoặc nhờ admin cấu hình.`,
      );
    } else if (!opts.googleAccessToken?.trim()) {
      needsGoogleAuth = true;
      const urls = [
        ...sheetRefs.map((r) => r.url),
        ...docRefs.map((r) => r.url),
      ].slice(0, 5);
      googleParts.push(
        `## Google Docs / Sheets (chỉ đọc)
Phát hiện link Google nhưng **chưa Authorize**:
${urls.map((u) => `- ${u}`).join("\n")}

→ Mở **Settings BA → Google** bấm Authorize (readonly), rồi chạy lại / gửi lại tin nhắn.`,
      );
    } else {
      const token = opts.googleAccessToken.trim();
      const sheetBlocks = [];
      const effectiveSheets = [...sheetRefs];

      for (const ref of docRefs) {
        try {
          const block = await fetchGoogleDocForPrompt(token, ref);
          if (block.asSheetId) {
            effectiveSheets.push({
              spreadsheetId: block.asSheetId,
              url: ref.url,
            });
            continue;
          }
          if (block.text || block.error) {
            googleParts.push(formatDocsPromptBlock([block]));
            labels.push(`Docs «${block.title}»`);
          }
        } catch (err) {
          logger.warn("BA Google Doc load failed", {
            fileId: ref.fileId,
            err: String(err),
          });
        }
      }

      // Dedupe sheets
      const seenSheet = new Set<string>();
      for (const ref of effectiveSheets) {
        if (seenSheet.has(ref.spreadsheetId)) continue;
        seenSheet.add(ref.spreadsheetId);
        sheetBlocks.push(await fetchSheetValuesForPrompt(token, ref));
        labels.push(`Sheet ${ref.spreadsheetId.slice(0, 8)}…`);
      }
      if (sheetBlocks.length) {
        googleParts.push(formatSheetsPromptBlock(sheetBlocks));
      }
    }
  }

  const parts = [gitlab.block, ...googleParts].filter((p) => p?.trim());
  return {
    block: parts.join("\n\n"),
    gitlabRefs: gitlab.refs,
    sheetRefs,
    docRefs,
    needsGoogleAuth,
    progressLabel: labels.length ? `Đang đọc ${labels.join(" · ")}…` : undefined,
  };
}

/** Detect if text mentions linkable external refs (for UI hints). */
export function baTextHasLinkedRefs(text: string): boolean {
  if (!text?.trim()) return false;
  return (
    /(?:^|[^A-Za-z0-9_/])#\d+\b|\/-\/(?:issues|work_items)\/\d+/i.test(text) ||
    /docs\.google\.com\/(?:spreadsheets|document)\/d\//i.test(text) ||
    /drive\.google\.com\/(?:file\/d\/|open\?id=)/i.test(text)
  );
}
