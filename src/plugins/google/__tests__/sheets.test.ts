import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  collectSheetRefsFromTexts,
  extractGoogleSheetRefs,
  isOfficeFileSheetsError,
  officeBytesToCsv,
} from "../sheets.js";

describe("extractGoogleSheetRefs", () => {
  it("parses spreadsheet id and gid", () => {
    const refs = extractGoogleSheetRefs(
      "See https://docs.google.com/spreadsheets/d/1AbC_xyz-123/edit#gid=42 for data",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].spreadsheetId).toBe("1AbC_xyz-123");
    expect(refs[0].gid).toBe("42");
  });

  it("dedupes by spreadsheet id across texts", () => {
    const refs = collectSheetRefsFromTexts([
      "https://docs.google.com/spreadsheets/d/abc123/edit",
      "also https://docs.google.com/spreadsheets/d/abc123/edit?gid=7",
      "other https://docs.google.com/spreadsheets/d/zzz999/edit",
    ]);
    expect(refs.map((r) => r.spreadsheetId).sort()).toEqual([
      "abc123",
      "zzz999",
    ]);
    expect(refs.find((r) => r.spreadsheetId === "abc123")?.gid).toBe("7");
  });
});

describe("office / error helpers", () => {
  it("detects office-file Sheets API errors", () => {
    expect(
      isOfficeFileSheetsError(
        "This operation is not supported for this document. The document must not be an Office file.",
      ),
    ).toBe(true);
    expect(
      isOfficeFileSheetsError(
        "OFFICE_FILE_ON_DRIVE: File Excel/Office trên Drive — cần đọc qua Drive API.",
      ),
    ).toBe(true);
  });

  it("parses xlsx bytes to csv", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Name", "Qty"],
      ["A", 1],
      ["B", 2],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const parsed = officeBytesToCsv(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    expect(parsed.sheetTitle).toBe("Data");
    expect(parsed.csv).toContain("Name");
    expect(parsed.csv).toContain("A");
  });
});
