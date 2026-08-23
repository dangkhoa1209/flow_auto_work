import { describe, expect, it } from "vitest";
import {
  collectGoogleDocRefsFromTexts,
  extractGoogleDocRefs,
  extractGoogleDriveFileRefs,
} from "../docs.js";
import { extractGoogleSheetRefs } from "../sheets.js";
import { baTextHasLinkedRefs } from "../../ba/ba-linked-context.js";

describe("extractGoogleDocRefs", () => {
  it("parses docs.google.com/document links", () => {
    const refs = extractGoogleDocRefs(
      "Xem https://docs.google.com/document/d/1AbC_docxyz/edit yêu cầu PD",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].fileId).toBe("1AbC_docxyz");
    expect(refs[0].kind).toBe("document");
  });
});

describe("extractGoogleDriveFileRefs", () => {
  it("parses drive file links", () => {
    const refs = extractGoogleDriveFileRefs(
      "File: https://drive.google.com/file/d/1DriveFile99/view?usp=sharing",
    );
    expect(refs[0].fileId).toBe("1DriveFile99");
  });
});

describe("extractGoogleSheetRefs drive file", () => {
  it("parses drive.google.com/file/d for excel", () => {
    const refs = extractGoogleSheetRefs(
      "https://drive.google.com/file/d/1ExcelAbc/view",
    );
    expect(refs[0].spreadsheetId).toBe("1ExcelAbc");
  });
});

describe("collectGoogleDocRefsFromTexts", () => {
  it("dedupes and prefers document over drive for same id", () => {
    const refs = collectGoogleDocRefsFromTexts([
      "https://drive.google.com/file/d/sameId1/view",
      "https://docs.google.com/document/d/sameId1/edit",
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("document");
  });
});

describe("baTextHasLinkedRefs", () => {
  it("detects gitlab hash and google links", () => {
    expect(baTextHasLinkedRefs("xem #42 giúp")).toBe(true);
    expect(
      baTextHasLinkedRefs("https://docs.google.com/document/d/x/edit"),
    ).toBe(true);
    expect(baTextHasLinkedRefs("không có gì")).toBe(false);
  });
});
