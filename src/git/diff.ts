import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRepoPath } from "../workspace/creds.js";
import { detectDefaultBranch } from "./prep.js";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  const repoPath = resolveRepoPath();
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function gitOk(args: string[]): Promise<string | null> {
  try {
    return await git(args);
  } catch {
    return null;
  }
}

async function revExists(ref: string): Promise<boolean> {
  const out = await gitOk(["rev-parse", "--verify", ref]);
  return Boolean(out?.trim());
}

export type DiffFileStat = {
  path: string;
  /** A | M | D | R | C | T | … */
  status: string;
  additions: number;
  deletions: number;
};

export type DiffPayload = {
  /** Label for the tip being reviewed (branch name or sha) */
  branch: string;
  /** Resolved tip ref (sha or branch) used in diff */
  tip: string;
  base: string;
  /** Human label e.g. origin/main...feat/1/foo */
  comparedLabel: string;
  rangeDiff: string;
  unstaged: string;
  staged: string;
  recentCommits: string;
  files: DiffFileStat[];
  /** Short --stat summary */
  summary: string;
  /** True if tip is current HEAD (so staged/unstaged are meaningful) */
  tipIsHead: boolean;
};

async function resolveTip(opts?: {
  branch?: string;
  commitSha?: string;
}): Promise<{ tip: string; label: string }> {
  const br = opts?.branch?.trim();
  if (br) {
    if (await revExists(br)) return { tip: br, label: br };
    if (await revExists(`origin/${br}`)) {
      return { tip: `origin/${br}`, label: br };
    }
  }
  const sha = opts?.commitSha?.trim();
  if (sha && (await revExists(sha))) {
    return { tip: sha, label: sha.slice(0, 10) };
  }
  const head = (await gitOk(["rev-parse", "HEAD"]))?.trim() || "HEAD";
  const cur =
    (await gitOk(["branch", "--show-current"]))?.trim() || head.slice(0, 10);
  return { tip: head, label: cur };
}

async function resolveBase(preferred?: string): Promise<string> {
  const p = preferred?.trim();
  if (p) {
    if (await revExists(`origin/${p}`)) return `origin/${p}`;
    if (await revExists(p)) return p;
  }
  const detected = await detectDefaultBranch(resolveRepoPath());
  if (await revExists(`origin/${detected}`)) return `origin/${detected}`;
  return detected;
}

function parseNumstat(text: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const additions = m[1] === "-" ? 0 : Number(m[1]);
    const deletions = m[2] === "-" ? 0 : Number(m[2]);
    let path = m[3].trim();
    // renames: old => new
    const arrow = path.lastIndexOf(" => ");
    if (arrow >= 0) path = path.slice(arrow + 4).trim();
    map.set(path, { additions, deletions });
  }
  return map;
}

function parseNameStatus(text: string): { path: string; status: string }[] {
  const out: { path: string; status: string }[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const status = (parts[0] || "?").charAt(0);
    const path = (parts[parts.length - 1] || "").trim();
    if (path) out.push({ path, status });
  }
  return out;
}

/** Diff for code review in UI — prefers job branch/commit over current HEAD. */
export async function getReviewDiff(opts?: {
  issueIid?: number;
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
}): Promise<DiffPayload> {
  const repoPath = resolveRepoPath();
  const { tip, label } = await resolveTip(opts);
  const base = await resolveBase(opts?.baseBranch);

  const headSha = (await gitOk(["rev-parse", "HEAD"]))?.trim() || "";
  const tipSha = (await gitOk(["rev-parse", tip]))?.trim() || tip;
  const tipIsHead = Boolean(headSha && tipSha && headSha === tipSha);

  const range = `${base}...${tip}`;
  const comparedLabel = range;

  // Best-effort fetch of base
  const baseName = base.replace(/^origin\//, "");
  await execFileAsync("git", ["fetch", "origin", baseName, "--quiet"], {
    cwd: repoPath,
  }).catch(() => undefined);

  let rangeDiff = (await gitOk(["diff", "--find-renames", range])) || "";
  if (!rangeDiff.trim() && tip !== "HEAD") {
    rangeDiff =
      (await gitOk(["diff", "--find-renames", `${baseName}...${tip}`])) ||
      rangeDiff;
  }

  const summary =
    (await gitOk(["diff", "--stat", "--find-renames", range]))?.trim() || "";
  const numstatText =
    (await gitOk(["diff", "--numstat", "--find-renames", range])) || "";
  const nameStatusText =
    (await gitOk(["diff", "--name-status", "--find-renames", range])) || "";
  const numMap = parseNumstat(numstatText);
  const nameRows = parseNameStatus(nameStatusText);
  const files: DiffFileStat[] = nameRows.map((r) => {
    const n = numMap.get(r.path) || { additions: 0, deletions: 0 };
    return {
      path: r.path,
      status: r.status,
      additions: n.additions,
      deletions: n.deletions,
    };
  });

  let unstaged = "";
  let staged = "";
  if (tipIsHead) {
    unstaged = (await gitOk(["diff"])) || "";
    staged = (await gitOk(["diff", "--cached"])) || "";
  }

  let recentCommits = "";
  try {
    if (opts?.issueIid) {
      recentCommits =
        (await gitOk([
          "log",
          "-20",
          "--oneline",
          tip,
          `--grep=#${opts.issueIid}`,
        ])) || "";
    }
    if (!recentCommits.trim()) {
      recentCommits =
        (await gitOk([
          "log",
          "-15",
          "--oneline",
          `${base}..${tip}`,
        ])) ||
        (await gitOk(["log", "-10", "--oneline", tip])) ||
        "";
    }
  } catch {
    recentCommits = "";
  }

  const curBranch =
    (await gitOk(["branch", "--show-current"]))?.trim() || "(detached)";

  return {
    branch: opts?.branch?.trim() || label || curBranch,
    tip,
    base,
    comparedLabel,
    rangeDiff,
    unstaged,
    staged,
    recentCommits: recentCommits.trim(),
    files,
    summary,
    tipIsHead,
  };
}
