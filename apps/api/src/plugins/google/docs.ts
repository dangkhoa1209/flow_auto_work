import { logger } from "../../logger.js";

export type GoogleDocRef = {
  fileId: string;
  url: string;
  kind: "document" | "drive";
};

const DOC_URL_RE =
  /https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9-_]+)[^\s)\]>"']*/gi;
const DRIVE_FILE_URL_RE =
  /https?:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9-_]+)[^\s)\]>"']*/gi;

const MAX_DOC_CHARS = 40_000;
const MAX_DOCS = 3;

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const OFFICE_SHEET_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
  "text/tab-separated-values",
]);

/** Parse Google Docs links from free text. */
export function extractGoogleDocRefs(text: string): GoogleDocRef[] {
  if (!text?.trim()) return [];
  const out: GoogleDocRef[] = [];
  const seen = new Set<string>();
  const take = (fileId: string, url: string, kind: GoogleDocRef["kind"]) => {
    if (!fileId || seen.has(fileId)) return;
    seen.add(fileId);
    out.push({ fileId, url: url.replace(/[.,;]+$/, ""), kind });
  };
  let m: RegExpExecArray | null;
  const docRe = new RegExp(DOC_URL_RE.source, DOC_URL_RE.flags);
  while ((m = docRe.exec(text)) !== null) {
    take(m[1], m[0], "document");
  }
  return out.slice(0, MAX_DOCS);
}

/**
 * Drive file links that are NOT already covered as spreadsheet/open?id in sheets extractor
 * when they appear as docs.google.com/document — those go to extractGoogleDocRefs.
 * For bare drive.google.com/file/d/ — caller may route via Drive meta.
 */
export function extractGoogleDriveFileRefs(text: string): GoogleDocRef[] {
  if (!text?.trim()) return [];
  const out: GoogleDocRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(DRIVE_FILE_URL_RE.source, DRIVE_FILE_URL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const fileId = m[1];
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    out.push({
      fileId,
      url: m[0].replace(/[.,;]+$/, ""),
      kind: "drive",
    });
  }
  return out.slice(0, MAX_DOCS);
}

export function collectGoogleDocRefsFromTexts(texts: string[]): GoogleDocRef[] {
  const map = new Map<string, GoogleDocRef>();
  for (const t of texts) {
    for (const ref of [
      ...extractGoogleDocRefs(t),
      ...extractGoogleDriveFileRefs(t),
    ]) {
      const prev = map.get(ref.fileId);
      if (!prev || (prev.kind === "drive" && ref.kind === "document")) {
        map.set(ref.fileId, ref);
      }
    }
  }
  return [...map.values()].slice(0, MAX_DOCS);
}

export type FetchedDocBlock = {
  fileId: string;
  url: string;
  title: string;
  mimeType: string;
  text: string;
  truncated: boolean;
  error?: string;
  /** Khi file là sheet/excel — caller nên dùng Sheets fetcher thay thế. */
  asSheetId?: string;
};

async function driveGetMeta(
  accessToken: string,
  fileId: string,
): Promise<{ name: string; mimeType: string }> {
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?fields=name,mimeType&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive meta HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { name?: string; mimeType?: string };
  return {
    name: json.name?.trim() || fileId,
    mimeType: json.mimeType || "",
  };
}

async function driveExportPlain(
  accessToken: string,
  fileId: string,
): Promise<string> {
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export` +
    `?mimeType=${encodeURIComponent("text/plain")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive export HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.text();
}

/** Fetch Google Doc / Drive document text for prompt. */
export async function fetchGoogleDocForPrompt(
  accessToken: string,
  ref: GoogleDocRef,
): Promise<FetchedDocBlock> {
  try {
    const meta = await driveGetMeta(accessToken, ref.fileId);

    if (
      meta.mimeType === GOOGLE_SHEET_MIME ||
      OFFICE_SHEET_MIME.has(meta.mimeType)
    ) {
      return {
        fileId: ref.fileId,
        url: ref.url,
        title: meta.name,
        mimeType: meta.mimeType,
        text: "",
        truncated: false,
        asSheetId: ref.fileId,
      };
    }

    if (meta.mimeType !== GOOGLE_DOC_MIME && ref.kind === "drive") {
      // Word/other: try export anyway (may fail for binary Office)
      if (
        meta.mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        meta.mimeType === "application/msword"
      ) {
        return {
          fileId: ref.fileId,
          url: ref.url,
          title: meta.name,
          mimeType: meta.mimeType,
          text: "",
          truncated: false,
          error:
            "File Word trên Drive — hãy File → Save as Google Docs hoặc dán nội dung vào YC.",
        };
      }
    }

    let text = await driveExportPlain(accessToken, ref.fileId);
    let truncated = false;
    if (text.length > MAX_DOC_CHARS) {
      text = `${text.slice(0, MAX_DOC_CHARS)}\n…(truncated)`;
      truncated = true;
    }
    return {
      fileId: ref.fileId,
      url: ref.url,
      title: meta.name,
      mimeType: meta.mimeType || GOOGLE_DOC_MIME,
      text: text.trim() || "(empty document)",
      truncated,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Google Doc fetch failed", { fileId: ref.fileId, err: msg });
    return {
      fileId: ref.fileId,
      url: ref.url,
      title: ref.fileId,
      mimeType: "?",
      text: "",
      truncated: false,
      error: msg,
    };
  }
}

export function formatDocsPromptBlock(blocks: FetchedDocBlock[]): string {
  const usable = blocks.filter((b) => !b.asSheetId);
  if (!usable.length) return "";
  const parts = usable.map((b, i) => {
    const head = `### Tài liệu ${i + 1}: ${b.title}
URL: ${b.url}
ID: ${b.fileId}${b.truncated ? "\n(Note: truncated)" : ""}`;
    if (b.error) return `${head}\nKhông đọc được: ${b.error}`;
    return `${head}\n\`\`\`\n${b.text}\n\`\`\``;
  });
  return `## Google Docs / tài liệu Drive (chỉ đọc — hệ thống đã kéo sẵn)
Dùng nội dung dưới làm ngữ cảnh yêu cầu. Không bịa nội dung không có trong tài liệu.

${parts.join("\n\n")}`;
}
