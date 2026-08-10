import * as XLSX from "xlsx";
import { logger } from "../../logger.js";

export type GoogleSheetRef = {
  spreadsheetId: string;
  gid?: string;
  url: string;
};

const SHEET_URL_RE =
  /https?:\/\/(?:docs\.google\.com\/spreadsheets\/d\/|drive\.google\.com\/open\?id=)([a-zA-Z0-9-_]+)[^\s)\]>"']*/gi;

const MAX_ROWS = 200;
const MAX_COLS = 40;
const MAX_CHARS = 80_000;

const OFFICE_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel", // xls
  "application/vnd.oasis.opendocument.spreadsheet", // ods
  "text/csv",
  "text/tab-separated-values",
]);

const NATIVE_SHEETS_MIME = "application/vnd.google-apps.spreadsheet";

/** Parse Google Sheets / Drive-open links from free text. */
export function extractGoogleSheetRefs(text: string): GoogleSheetRef[] {
  if (!text?.trim()) return [];
  const out: GoogleSheetRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(SHEET_URL_RE.source, SHEET_URL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    const spreadsheetId = m[1];
    if (!spreadsheetId || seen.has(spreadsheetId)) continue;
    seen.add(spreadsheetId);
    let gid: string | undefined;
    try {
      const u = new URL(full.replace(/[.,;]+$/, ""));
      const g =
        u.searchParams.get("gid") ||
        (full.match(/[#&]gid=(\d+)/i) || [])[1];
      if (g) gid = g;
    } catch {
      const g = (full.match(/[#&?]gid=(\d+)/i) || [])[1];
      if (g) gid = g;
    }
    out.push({ spreadsheetId, gid, url: full.replace(/[.,;]+$/, "") });
  }
  return out;
}

export function collectSheetRefsFromTexts(texts: string[]): GoogleSheetRef[] {
  const map = new Map<string, GoogleSheetRef>();
  for (const t of texts) {
    for (const ref of extractGoogleSheetRefs(t)) {
      const prev = map.get(ref.spreadsheetId);
      if (!prev) map.set(ref.spreadsheetId, ref);
      else if (!prev.gid && ref.gid) map.set(ref.spreadsheetId, ref);
    }
  }
  return [...map.values()];
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function valuesToCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((c) => escapeCsvCell(c)).join(","))
    .join("\n");
}

function truncateGrid(values: unknown[][]): {
  rows: string[][];
  truncated: boolean;
} {
  let truncated = false;
  const limited = values.slice(0, MAX_ROWS);
  if (values.length > MAX_ROWS) truncated = true;
  const rows: string[][] = limited.map((row) => {
    const arr = Array.isArray(row) ? row : [];
    if (arr.length > MAX_COLS) truncated = true;
    return arr.slice(0, MAX_COLS).map((c) => {
      if (c == null) return "";
      return String(c);
    });
  });
  return { rows, truncated };
}

function finalizeCsv(raw: unknown[][]): {
  csv: string;
  truncated: boolean;
} {
  const { rows, truncated: gridTrunc } = truncateGrid(raw);
  let csv = valuesToCsv(rows);
  let truncated = gridTrunc;
  if (csv.length > MAX_CHARS) {
    csv = `${csv.slice(0, MAX_CHARS)}\n…(truncated)`;
    truncated = true;
  }
  return { csv: csv || "(empty sheet)", truncated };
}

async function sheetsApiGet(
  accessToken: string,
  path: string,
): Promise<unknown> {
  const url = `https://sheets.googleapis.com/v4${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(
      formatSheetsApiError(res.status, body, res.statusText),
    ) as Error & { sheetsStatus?: number; sheetsBody?: string };
    err.sheetsStatus = res.status;
    err.sheetsBody = body;
    throw err;
  }
  return res.json();
}

/** Detect Office-file rejection from Sheets API (raw or formatted message). */
export function isOfficeFileSheetsError(message: string, body?: string): boolean {
  const hay = `${message}\n${body || ""}`.toLowerCase();
  return (
    hay.includes("must not be an office file") ||
    hay.includes("not supported for this document") ||
    hay.includes("office file") ||
    // Formatted VI message from formatSheetsApiError
    hay.includes("excel/office") ||
    hay.includes("chưa convert sang google sheets")
  );
}

/** Human-readable Sheets API errors (esp. API not enabled). */
export function formatSheetsApiError(
  status: number,
  body: string,
  statusText?: string,
): string {
  const raw = (body || "").trim();
  let message = "";
  try {
    const json = JSON.parse(raw) as {
      error?: { message?: string; status?: string; details?: unknown[] };
    };
    message = json.error?.message?.trim() || "";
  } catch {
    message = raw.slice(0, 180);
  }
  const lower = message.toLowerCase();
  if (
    status === 403 &&
    (lower.includes("has not been used") ||
      lower.includes("is disabled") ||
      lower.includes("access not configured") ||
      lower.includes("sheets api"))
  ) {
    return (
      "Google Sheets API chưa bật trên Cloud project. " +
      "Vào Google Cloud Console → APIs & Services → Enable **Google Sheets API**, " +
      "đợi ~1 phút rồi Authorize / Run lại. " +
      "Link: https://console.cloud.google.com/apis/library/sheets.googleapis.com"
    );
  }
  if (isOfficeFileSheetsError(message, raw)) {
    // Keep a stable marker so callers can fall back to Drive download
    return "OFFICE_FILE_ON_DRIVE: File Excel/Office trên Drive — cần đọc qua Drive API.";
  }
  if (status === 403 && lower.includes("permission")) {
    return `Không có quyền đọc sheet này (${message.slice(0, 120) || "403"})`;
  }
  if (status === 404) {
    return "Không tìm thấy spreadsheet (sai ID hoặc đã xóa)";
  }
  const short = (message || statusText || "").slice(0, 160);
  return `Sheets API ${status}${short ? `: ${short}` : ""}`;
}

type DriveFileMeta = {
  id?: string;
  name?: string;
  mimeType?: string;
};

async function driveGetMeta(
  accessToken: string,
  fileId: string,
): Promise<DriveFileMeta> {
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?fields=id,name,mimeType&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403 && /drive/i.test(body) && /not been used|disabled/i.test(body)) {
      throw new Error(
        "Google Drive API chưa bật. Enable tại https://console.cloud.google.com/apis/library/drive.googleapis.com rồi Authorize / Run lại.",
      );
    }
    if (res.status === 403 || res.status === 401) {
      throw new Error(
        "Thiếu quyền Drive readonly — bấm Revoke rồi Authorize Google lại (cần scope Drive để đọc Excel).",
      );
    }
    throw new Error(
      `Drive API ${res.status}: ${(body || res.statusText).slice(0, 160)}`,
    );
  }
  return (await res.json()) as DriveFileMeta;
}

async function driveDownloadBytes(
  accessToken: string,
  fileId: string,
): Promise<ArrayBuffer> {
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Drive download ${res.status}: ${(body || res.statusText).slice(0, 160)}`,
    );
  }
  return res.arrayBuffer();
}

/** Parse Excel/CSV bytes into a truncated CSV string for the prompt. */
export function officeBytesToCsv(
  bytes: ArrayBuffer,
  opts?: { sheetIndex?: number; sheetName?: string },
): { csv: string; truncated: boolean; sheetTitle: string; titleHint?: string } {
  const wb = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  const names = wb.SheetNames || [];
  if (!names.length) {
    return { csv: "(empty workbook)", truncated: false, sheetTitle: "?" };
  }
  let sheetTitle = names[0];
  if (opts?.sheetName && names.includes(opts.sheetName)) {
    sheetTitle = opts.sheetName;
  } else if (
    opts?.sheetIndex != null &&
    opts.sheetIndex >= 0 &&
    opts.sheetIndex < names.length
  ) {
    sheetTitle = names[opts.sheetIndex];
  }
  const sheet = wb.Sheets[sheetTitle];
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  }) as unknown[][];
  const { csv, truncated } = finalizeCsv(raw);
  return { csv, truncated, sheetTitle };
}

async function fetchNativeSheet(
  accessToken: string,
  ref: GoogleSheetRef,
): Promise<FetchedSheetBlock> {
  const { title, sheetTitle } = await resolveSheetTitle(
    accessToken,
    ref.spreadsheetId,
    ref.gid,
  );
  const range = `'${sheetTitle.replace(/'/g, "''")}'`;
  const data = (await sheetsApiGet(
    accessToken,
    `/spreadsheets/${encodeURIComponent(ref.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
  )) as { values?: unknown[][] };

  const raw = Array.isArray(data.values) ? data.values : [];
  const { csv, truncated } = finalizeCsv(raw);
  return {
    spreadsheetId: ref.spreadsheetId,
    url: ref.url,
    title,
    sheetTitle,
    csv,
    truncated,
  };
}

async function fetchOfficeViaDrive(
  accessToken: string,
  ref: GoogleSheetRef,
  meta?: DriveFileMeta,
): Promise<FetchedSheetBlock> {
  const fileMeta = meta ?? (await driveGetMeta(accessToken, ref.spreadsheetId));
  const mime = fileMeta.mimeType || "";
  const title = fileMeta.name?.trim() || ref.spreadsheetId;

  if (mime === NATIVE_SHEETS_MIME) {
    return fetchNativeSheet(accessToken, ref);
  }

  if (!OFFICE_MIME.has(mime) && !/\.xlsx?$/i.test(title) && !/\.csv$/i.test(title)) {
    throw new Error(
      `Drive file MIME không hỗ trợ đọc bảng: ${mime || "(unknown)"}. ` +
        `Convert sang Google Sheets (File → Save as Google Sheets) rồi Run lại.`,
    );
  }

  const bytes = await driveDownloadBytes(accessToken, ref.spreadsheetId);
  const parsed = officeBytesToCsv(bytes);
  return {
    spreadsheetId: ref.spreadsheetId,
    url: ref.url,
    title,
    sheetTitle: parsed.sheetTitle,
    csv: parsed.csv,
    truncated: parsed.truncated,
  };
}

async function resolveSheetTitle(
  accessToken: string,
  spreadsheetId: string,
  gid?: string,
): Promise<{ title: string; sheetTitle: string }> {
  const meta = (await sheetsApiGet(
    accessToken,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties`,
  )) as {
    properties?: { title?: string };
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  const bookTitle = meta.properties?.title?.trim() || spreadsheetId;
  let sheetTitle = "Sheet1";
  if (gid != null && gid !== "") {
    const want = Number(gid);
    const match = meta.sheets?.find(
      (s) => Number(s.properties?.sheetId) === want,
    );
    if (match?.properties?.title) sheetTitle = match.properties.title;
  } else if (meta.sheets?.[0]?.properties?.title) {
    sheetTitle = meta.sheets[0].properties.title;
  }
  return { title: bookTitle, sheetTitle };
}

export type FetchedSheetBlock = {
  spreadsheetId: string;
  url: string;
  title: string;
  sheetTitle: string;
  csv: string;
  truncated: boolean;
  error?: string;
};

/** Fetch computed values for one sheet ref; truncate for prompt size. */
export async function fetchSheetValuesForPrompt(
  accessToken: string,
  ref: GoogleSheetRef,
): Promise<FetchedSheetBlock> {
  try {
    // 1) Drive metadata first — Excel uploads never work via Sheets API
    let driveMeta: DriveFileMeta | null = null;
    let driveMetaError: string | null = null;
    try {
      driveMeta = await driveGetMeta(accessToken, ref.spreadsheetId);
    } catch (err) {
      driveMetaError = err instanceof Error ? err.message : String(err);
      logger.warn("Drive metadata lookup failed", {
        spreadsheetId: ref.spreadsheetId,
        err: driveMetaError,
      });
    }

    if (driveMeta?.mimeType && OFFICE_MIME.has(driveMeta.mimeType)) {
      return await fetchOfficeViaDrive(accessToken, ref, driveMeta);
    }

    if (
      driveMeta?.mimeType === NATIVE_SHEETS_MIME ||
      (!driveMeta && !driveMetaError)
    ) {
      try {
        return await fetchNativeSheet(accessToken, ref);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const body =
          err && typeof err === "object" && "sheetsBody" in err
            ? String((err as { sheetsBody?: string }).sheetsBody || "")
            : "";
        if (isOfficeFileSheetsError(msg, body)) {
          logger.info("Sheets API rejected Office file — Drive download", {
            spreadsheetId: ref.spreadsheetId,
          });
          return await fetchOfficeViaDrive(
            accessToken,
            ref,
            driveMeta ?? undefined,
          );
        }
        throw err;
      }
    }

    // Drive meta failed (often missing drive.readonly) but file may still be Excel
    // Try Sheets first; on Office rejection, try Drive download (will surface scope error)
    if (!driveMeta) {
      try {
        return await fetchNativeSheet(accessToken, ref);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const body =
          err && typeof err === "object" && "sheetsBody" in err
            ? String((err as { sheetsBody?: string }).sheetsBody || "")
            : "";
        if (isOfficeFileSheetsError(msg, body)) {
          try {
            return await fetchOfficeViaDrive(accessToken, ref);
          } catch (driveErr) {
            const dmsg =
              driveErr instanceof Error ? driveErr.message : String(driveErr);
            throw new Error(
              `${dmsg}` +
                (driveMetaError ? ` (Drive meta: ${driveMetaError})` : ""),
            );
          }
        }
        throw err;
      }
    }

    // Other Drive MIME — try Office download by name/extension
    return await fetchOfficeViaDrive(accessToken, ref, driveMeta);
  } catch (err) {
    logger.warn("Sheets fetch failed", {
      spreadsheetId: ref.spreadsheetId,
      err: String(err),
    });
    let error = err instanceof Error ? err.message : String(err);
    // Don't leave the internal OFFICE_FILE marker as the only user text
    if (error.startsWith("OFFICE_FILE_ON_DRIVE:")) {
      error =
        "File Excel/Office trên Drive — đọc qua Drive thất bại. " +
        "Enable Google Drive API, rồi Revoke + Authorize Google lại (scope Drive readonly), sau đó Run lại. " +
        "Hoặc mở file → File → Save as Google Sheets.";
    }
    return {
      spreadsheetId: ref.spreadsheetId,
      url: ref.url,
      title: ref.spreadsheetId,
      sheetTitle: "?",
      csv: "",
      truncated: false,
      error,
    };
  }
}

/** Build `# LINKED GOOGLE SHEETS` prompt section. */
export function formatSheetsPromptBlock(blocks: FetchedSheetBlock[]): string {
  if (!blocks.length) return "";
  const parts = blocks.map((b, i) => {
    const head = `### Sheet ${i + 1}: ${b.title} / ${b.sheetTitle}
URL: ${b.url}
ID: ${b.spreadsheetId}${b.truncated ? "\n(Note: content truncated for prompt size)" : ""}`;
    if (b.error) {
      return `${head}\nError reading sheet: ${b.error}`;
    }
    return `${head}\n\`\`\`csv\n${b.csv}\n\`\`\``;
  });
  return `# LINKED GOOGLE SHEETS
Read-only excerpts from Google Sheets linked in this task. Use as data/requirements context. Do not invent rows that are not shown.

${parts.join("\n\n")}`;
}
