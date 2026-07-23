export type DiffFileStat = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type DiffRow = {
  kind: "meta" | "hunk" | "add" | "del" | "ctx";
  oldNo: string;
  newNo: string;
  sign: string;
  text: string;
};

export type DiffBlock = {
  path: string;
  body: string;
};

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

export function splitUnifiedDiff(diffText: string): DiffBlock[] {
  if (!diffText?.trim()) return [];
  const parts = diffText.split(/(?=^diff --git )/m).filter((p) => p.trim());
  return parts.map((block) => {
    const first = block.split("\n")[0] || "";
    const m = first.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const path = m ? m[2] : first.replace(/^diff --git\s+/, "") || "file";
    return { path, body: block };
  });
}

export function parseDiffRows(body: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of body.split("\n")) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file")
    ) {
      rows.push({ kind: "meta", oldNo: "", newNo: "", sign: "", text: line });
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      rows.push({ kind: "meta", oldNo: "", newNo: "", sign: "", text: line });
      continue;
    }
    if (line.startsWith("@@")) {
      const h = parseHunkHeader(line);
      if (h) {
        oldNo = h.oldStart;
        newNo = h.newStart;
      }
      rows.push({ kind: "hunk", oldNo: "", newNo: "", sign: "", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({
        kind: "add",
        oldNo: "",
        newNo: String(newNo),
        sign: "+",
        text: line.slice(1),
      });
      newNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({
        kind: "del",
        oldNo: String(oldNo),
        newNo: "",
        sign: "−",
        text: line.slice(1),
      });
      oldNo += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", oldNo: "", newNo: "", sign: "", text: line });
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      kind: "ctx",
      oldNo: String(oldNo),
      newNo: String(newNo),
      sign: "",
      text,
    });
    oldNo += 1;
    newNo += 1;
  }
  return rows;
}

export function buildDiffBlocks(opts: {
  rangeDiff?: string;
  staged?: string;
  unstaged?: string;
}): DiffBlock[] {
  const blocks = splitUnifiedDiff(opts.rangeDiff || "");
  if (opts.staged?.trim()) {
    blocks.push({ path: "(staged)", body: opts.staged });
  }
  if (opts.unstaged?.trim()) {
    blocks.push({ path: "(unstaged WIP)", body: opts.unstaged });
  }
  return blocks;
}
