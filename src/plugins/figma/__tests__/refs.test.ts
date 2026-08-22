import { describe, expect, it } from "vitest";
import {
  collectFigmaRefsFromTexts,
  extractFigmaRefs,
  figmaIncludeKey,
  isFigmaFullReadKind,
  normalizeFigmaNodeId,
  parseFigmaIncludeKey,
} from "../refs.js";

describe("extractFigmaRefs", () => {
  it("parses design URL with node-id", () => {
    const refs = extractFigmaRefs(
      "UI: https://www.figma.com/design/AbC123xyz/Login?node-id=12-34&m=dev",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.fileKey).toBe("AbC123xyz");
    expect(refs[0]!.nodeId).toBe("12:34");
    expect(refs[0]!.kind).toBe("design");
    expect(figmaIncludeKey(refs[0]!)).toBe("AbC123xyz#12:34");
  });

  it("parses file and proto kinds", () => {
    const refs = collectFigmaRefsFromTexts([
      "https://figma.com/file/FileKey1/Old",
      "https://www.figma.com/proto/ProtoKey2/Flow?node-id=1:2",
    ]);
    expect(refs.map((r) => r.kind).sort()).toEqual(["file", "proto"]);
    expect(isFigmaFullReadKind("file")).toBe(true);
    expect(isFigmaFullReadKind("proto")).toBe(false);
  });

  it("dedupes by include key and prefers design over proto", () => {
    const refs = collectFigmaRefsFromTexts([
      "https://www.figma.com/proto/SameKey/P?node-id=1-1",
      "https://www.figma.com/design/SameKey/D?node-id=1-1",
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe("design");
  });
});

describe("figmaIncludeKey", () => {
  it("round-trips parse", () => {
    expect(parseFigmaIncludeKey("abc#1:2")).toEqual({
      fileKey: "abc",
      nodeId: "1:2",
    });
    expect(parseFigmaIncludeKey("abc")).toEqual({ fileKey: "abc" });
  });

  it("normalizes node ids", () => {
    expect(normalizeFigmaNodeId("1-2")).toBe("1:2");
    expect(normalizeFigmaNodeId("1:2")).toBe("1:2");
  });
});
