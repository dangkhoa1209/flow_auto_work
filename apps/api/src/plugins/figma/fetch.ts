/**
 * Fetch Figma node metadata + text (level A) and light variables (level B).
 * Server-side only — injected into agent prompt as figmaBlock.
 */

import { logger } from "../../logger.js";
import {
  figmaIncludeKey,
  isFigmaFullReadKind,
  type FigmaRef,
} from "./refs.js";

/** Caps tuned for Figma trees (not Sheets 80k). */
export const FIGMA_MAX_NODES = 80;
export const FIGMA_MAX_DEPTH = 6;
export const FIGMA_MAX_CHARS = 48_000;
export const FIGMA_MAX_TEXT_PER_NODE = 400;
export const FIGMA_MAX_VARIABLES = 80;

export type FetchedFigmaBlock = {
  fileKey: string;
  nodeId?: string;
  url: string;
  kind: FigmaRef["kind"];
  fileName?: string;
  rootName?: string;
  markdown: string;
  truncated: boolean;
  error?: string;
};

type FigmaNode = {
  id?: string;
  name?: string;
  type?: string;
  characters?: string;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  fills?: unknown[];
  children?: FigmaNode[];
  style?: Record<string, unknown>;
  absoluteBoundingBox?: { width?: number; height?: number };
};

function figmaHeaders(pat: string): HeadersInit {
  return { "X-Figma-Token": pat };
}

async function figmaGet(pat: string, path: string): Promise<unknown> {
  const url = `https://api.figma.com/v1${path}`;
  const res = await fetch(url, { headers: figmaHeaders(pat) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const snippet = body.slice(0, 240);
    throw new Error(
      `Figma API ${res.status}${snippet ? `: ${snippet}` : ""}`,
    );
  }
  return res.json();
}

function summarizeFills(fills: unknown[] | undefined): string | undefined {
  if (!Array.isArray(fills) || !fills.length) return undefined;
  const bits: string[] = [];
  for (const f of fills.slice(0, 3)) {
    if (!f || typeof f !== "object") continue;
    const fill = f as { type?: string; visible?: boolean; color?: Record<string, number> };
    if (fill.visible === false) continue;
    if (fill.type === "SOLID" && fill.color) {
      const { r = 0, g = 0, b = 0, a = 1 } = fill.color;
      const hex = [r, g, b]
        .map((c) =>
          Math.round(Math.min(1, Math.max(0, c)) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
      bits.push(a < 1 ? `#${hex}@${a.toFixed(2)}` : `#${hex}`);
    } else if (fill.type) {
      bits.push(fill.type);
    }
  }
  return bits.length ? bits.join(", ") : undefined;
}

function layoutHint(n: FigmaNode): string | undefined {
  if (!n.layoutMode || n.layoutMode === "NONE") return undefined;
  const parts = [`layout=${n.layoutMode}`];
  if (n.itemSpacing != null) parts.push(`gap=${n.itemSpacing}`);
  const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
  if (pad.some((p) => p != null && p !== 0)) {
    parts.push(`pad=${pad.map((p) => p ?? 0).join("/")}`);
  }
  if (n.primaryAxisAlignItems) parts.push(`main=${n.primaryAxisAlignItems}`);
  if (n.counterAxisAlignItems) parts.push(`cross=${n.counterAxisAlignItems}`);
  return parts.join(" ");
}

function walkNode(
  node: FigmaNode,
  depth: number,
  lines: string[],
  state: { nodes: number; truncated: boolean },
): void {
  if (state.nodes >= FIGMA_MAX_NODES) {
    state.truncated = true;
    return;
  }
  if (depth > FIGMA_MAX_DEPTH) {
    state.truncated = true;
    return;
  }
  state.nodes += 1;
  const indent = "  ".repeat(Math.min(depth, 12));
  const type = node.type || "NODE";
  const name = (node.name || "").trim() || "(unnamed)";
  const meta: string[] = [];
  const box = node.absoluteBoundingBox;
  if (box?.width != null && box?.height != null) {
    meta.push(`${Math.round(box.width)}×${Math.round(box.height)}`);
  }
  const layout = layoutHint(node);
  if (layout) meta.push(layout);
  const fill = summarizeFills(node.fills);
  if (fill) meta.push(`fill=${fill}`);
  lines.push(
    `${indent}- [${type}] ${name}${meta.length ? ` (${meta.join("; ")})` : ""}`,
  );
  if (type === "TEXT" && node.characters?.trim()) {
    let text = node.characters.replace(/\s+/g, " ").trim();
    if (text.length > FIGMA_MAX_TEXT_PER_NODE) {
      text = `${text.slice(0, FIGMA_MAX_TEXT_PER_NODE)}…`;
      state.truncated = true;
    }
    lines.push(`${indent}  text: ${JSON.stringify(text)}`);
  }
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (state.nodes >= FIGMA_MAX_NODES) {
      state.truncated = true;
      break;
    }
    walkNode(child, depth + 1, lines, state);
  }
}

async function fetchLocalVariables(
  pat: string,
  fileKey: string,
): Promise<{ lines: string[]; truncated: boolean }> {
  try {
    const raw = (await figmaGet(
      pat,
      `/files/${encodeURIComponent(fileKey)}/variables/local`,
    )) as {
      meta?: {
        variables?: Record<
          string,
          { name?: string; resolvedType?: string; valuesByMode?: Record<string, unknown> }
        >;
        variableCollections?: Record<string, { name?: string }>;
      };
    };
    const vars = raw.meta?.variables || {};
    const entries = Object.values(vars).slice(0, FIGMA_MAX_VARIABLES);
    const truncated = Object.keys(vars).length > FIGMA_MAX_VARIABLES;
    const lines = entries.map((v) => {
      const name = v.name || "(var)";
      const typ = v.resolvedType || "?";
      const modes = v.valuesByMode || {};
      const first = Object.values(modes)[0];
      let val = "";
      if (first && typeof first === "object" && first !== null && "r" in first) {
        const c = first as { r: number; g: number; b: number; a?: number };
        val = ` #${[c.r, c.g, c.b]
          .map((x) =>
            Math.round(Math.min(1, Math.max(0, x)) * 255)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")}`;
      } else if (first != null && typeof first !== "object") {
        val = ` = ${String(first)}`;
      }
      return `- ${name} (${typ})${val}`;
    });
    return { lines, truncated };
  } catch (err) {
    logger.info("Figma variables fetch skipped", {
      fileKey,
      err: String(err),
    });
    return { lines: [], truncated: false };
  }
}

async function fetchFileMeta(
  pat: string,
  fileKey: string,
): Promise<{ name: string; lastModified?: string }> {
  const raw = (await figmaGet(
    pat,
    `/files/${encodeURIComponent(fileKey)}?depth=1`,
  )) as { name?: string; lastModified?: string };
  return {
    name: raw.name || fileKey,
    lastModified: raw.lastModified,
  };
}

/**
 * Fetch one Figma ref into a prompt-ready block.
 * Proto/board → metadata only; design/file → node tree + light variables.
 */
export async function fetchFigmaForPrompt(
  pat: string,
  ref: FigmaRef,
): Promise<FetchedFigmaBlock> {
  const base: FetchedFigmaBlock = {
    fileKey: ref.fileKey,
    nodeId: ref.nodeId,
    url: ref.url,
    kind: ref.kind,
    markdown: "",
    truncated: false,
  };

  try {
    const meta = await fetchFileMeta(pat, ref.fileKey);
    base.fileName = meta.name;

    if (!isFigmaFullReadKind(ref.kind)) {
      base.markdown = [
        `Kind: ${ref.kind} (metadata only — open design/file link for full structure)`,
        `File: ${meta.name}`,
        ref.nodeId ? `Node id: ${ref.nodeId}` : null,
        meta.lastModified ? `Last modified: ${meta.lastModified}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return base;
    }

    const ids = ref.nodeId || undefined;
    let root: FigmaNode | undefined;
    let rootName: string | undefined;

    if (ids) {
      const raw = (await figmaGet(
        pat,
        `/files/${encodeURIComponent(ref.fileKey)}/nodes?ids=${encodeURIComponent(ids)}&depth=${FIGMA_MAX_DEPTH}`,
      )) as {
        name?: string;
        nodes?: Record<
          string,
          { document?: FigmaNode; name?: string } | undefined
        >;
      };
      if (raw.name) base.fileName = raw.name;
      const entry = raw.nodes?.[ids] || Object.values(raw.nodes || {})[0];
      root = entry?.document;
      rootName = root?.name || entry?.name;
    } else {
      const raw = (await figmaGet(
        pat,
        `/files/${encodeURIComponent(ref.fileKey)}?depth=${FIGMA_MAX_DEPTH}`,
      )) as { name?: string; document?: FigmaNode };
      if (raw.name) base.fileName = raw.name;
      root = raw.document;
      rootName = root?.name;
    }

    if (!root) {
      return {
        ...base,
        error: "Node/document not found in Figma response",
        markdown: "",
      };
    }
    base.rootName = rootName;

    const lines: string[] = [];
    const state = { nodes: 0, truncated: false };
    walkNode(root, 0, lines, state);
    let structure = lines.join("\n");
    if (structure.length > FIGMA_MAX_CHARS) {
      structure = `${structure.slice(0, FIGMA_MAX_CHARS)}\n…(truncated)`;
      state.truncated = true;
    }

    const vars = await fetchLocalVariables(pat, ref.fileKey);
    const varBlock = vars.lines.length
      ? `\n### Variables (sample)\n${vars.lines.join("\n")}`
      : "";

    base.truncated = state.truncated || vars.truncated;
    base.markdown = [
      `File: ${base.fileName}`,
      rootName ? `Root: ${rootName}` : null,
      ref.nodeId ? `Node id: ${ref.nodeId}` : null,
      base.truncated ? "(Note: truncated for prompt size)" : null,
      "",
      "### Structure",
      structure,
      varBlock,
    ]
      .filter((x) => x != null)
      .join("\n");
    return base;
  } catch (err) {
    logger.warn("Figma fetch failed", {
      fileKey: ref.fileKey,
      nodeId: ref.nodeId,
      err: String(err),
    });
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      markdown: "",
    };
  }
}

/** Build `# LINKED FIGMA` prompt section. */
export function formatFigmaPromptBlock(blocks: FetchedFigmaBlock[]): string {
  if (!blocks.length) return "";
  const parts = blocks.map((b, i) => {
    const label = b.rootName || b.fileName || b.fileKey;
    const head = `### Figma ${i + 1}: ${label}
URL: ${b.url}
Key: ${figmaIncludeKey(b)}${b.truncated ? "\n(Note: content truncated for prompt size)" : ""}`;
    if (b.error) {
      return `${head}\nError reading Figma: ${b.error}`;
    }
    return `${head}\n${b.markdown}`;
  });
  return `# LINKED FIGMA
Read-only structure / text / light variables from Figma links the human opted into.
Use as UI/UX requirements. Do not invent frames or copy that are not shown.
Do not call Figma APIs yourself.

${parts.join("\n\n")}`;
}
