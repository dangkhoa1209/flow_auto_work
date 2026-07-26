import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRepoPath } from "../../workspace/creds.js";
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
  /** Single-commit mode when set */
  mode: "range" | "commit";
  commitSha?: string;
};

export type JobCommitInfo = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
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

function parseNumstat(
  text: string,
): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const additions = m[1] === "-" ? 0 : Number(m[1]);
    const deletions = m[2] === "-" ? 0 : Number(m[2]);
    let path = m[3].trim();
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

async function buildFileStats(range: string): Promise<{
  files: DiffFileStat[];
  summary: string;
  rangeDiff: string;
}> {
  const rangeDiff = (await gitOk(["diff", "--find-renames", range])) || "";
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
  return { files, summary, rangeDiff };
}

function parseCommitLines(raw: string): JobCommitInfo[] {
  const out: JobCommitInfo[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [sha, subject, author, date] = line.split("\t");
    if (!sha) continue;
    out.push({
      sha: sha.trim(),
      shortSha: sha.trim().slice(0, 8),
      subject: (subject || "").trim() || "(no subject)",
      author: (author || "").trim(),
      date: (date || "").trim(),
    });
  }
  return out;
}

async function emptyTreeSha(): Promise<string> {
  // Git's well-known empty tree
  return "4b825dc642cb6eb9a060e54bf8d69288ddfcc230";
}

/** Structured commits for a job — git log on branch (fetch tip), merge stored SHAs. */
export async function listJobCommits(opts: {
  branch?: string;
  baseBranch?: string;
  commitShas?: string[];
  commitSha?: string;
  issueIid?: number;
  limit?: number;
}): Promise<JobCommitInfo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
  const repoPath = resolveRepoPath();
  const { tip, label } = await resolveTip({
    branch: opts.branch,
    commitSha: opts.commitSha,
  });
  const base = await resolveBase(opts.baseBranch);
  const baseName = base.replace(/^origin\//, "");
  const tipName = (opts.branch || label || "").replace(/^origin\//, "").trim();

  // Fetch tip + base so new GitLab API commits appear locally
  if (tipName) {
    await execFileAsync(
      "git",
      ["fetch", "origin", `+refs/heads/${tipName}:refs/remotes/origin/${tipName}`, "--quiet"],
      { cwd: repoPath },
    ).catch(() => undefined);
  }
  await execFileAsync("git", ["fetch", "origin", baseName, "--quiet"], {
    cwd: repoPath,
  }).catch(() => undefined);

  // Prefer remote tip when available
  let tipRef = tip;
  if (tipName && (await revExists(`origin/${tipName}`))) {
    tipRef = `origin/${tipName}`;
  }

  const logFmt = `--format=%H%x09%s%x09%an%x09%aI`;
  let raw =
    (await gitOk([
      "log",
      `-${limit}`,
      logFmt,
      `${base}..${tipRef}`,
    ])) || "";

  if (!raw.trim() && opts.issueIid && opts.issueIid > 0) {
    raw =
      (await gitOk([
        "log",
        `-${limit}`,
        logFmt,
        tipRef,
        `--grep=#${opts.issueIid}`,
      ])) || "";
  }
  if (!raw.trim()) {
    raw =
      (await gitOk(["log", `-${limit}`, logFmt, tipRef])) || "";
  }

  const bySha = new Map<string, JobCommitInfo>();
  for (const c of parseCommitLines(raw)) {
    bySha.set(c.sha, c);
  }

  // Backfill metadata for stored job SHAs (may be ahead of base..tip if fetch lag)
  const stored: string[] = [];
  if (opts.commitShas?.length) {
    for (const s of [...opts.commitShas].reverse()) {
      const t = s?.trim();
      if (t && !stored.includes(t)) stored.push(t);
    }
  }
  if (opts.commitSha?.trim() && !stored.includes(opts.commitSha.trim())) {
    stored.unshift(opts.commitSha.trim());
  }
  for (const sha of stored.slice(0, limit)) {
    if (bySha.has(sha)) continue;
    if (!(await revExists(sha))) {
      await gitOk(["fetch", "origin", sha]).catch(() => null);
    }
    if (!(await revExists(sha))) continue;
    const one = await gitOk(["log", "-1", logFmt, sha]);
    if (one?.trim()) {
      for (const c of parseCommitLines(one.trim())) bySha.set(c.sha, c);
    }
  }

  const commits = Array.from(bySha.values()).sort((a, b) => {
    const tb = Date.parse(b.date) || 0;
    const ta = Date.parse(a.date) || 0;
    if (tb !== ta) return tb - ta;
    return b.sha.localeCompare(a.sha);
  });
  return commits.slice(0, limit);
}

/** Diff for code review in UI — range (base…tip) or single commit (sha^..sha). */
export async function getReviewDiff(opts?: {
  issueIid?: number;
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
  /** When set, show only that commit's patch */
  singleCommit?: string;
}): Promise<DiffPayload> {
  const repoPath = resolveRepoPath();
  const single = opts?.singleCommit?.trim();

  if (single) {
    if (!(await revExists(single))) {
      await gitOk(["fetch", "origin", single]);
    }
    if (!(await revExists(single))) {
      throw new Error(`Commit not found locally: ${single.slice(0, 12)}`);
    }
    const fullSha = (await gitOk(["rev-parse", single]))?.trim() || single;
    const parent = (await gitOk(["rev-parse", `${fullSha}^`]))?.trim();
    const range = parent
      ? `${parent}..${fullSha}`
      : `${await emptyTreeSha()}..${fullSha}`;
    const { files, summary, rangeDiff } = await buildFileStats(range);
    const subject =
      (await gitOk(["log", "-1", "--format=%s", fullSha]))?.trim() ||
      fullSha.slice(0, 8);
    return {
      branch: opts?.branch?.trim() || fullSha.slice(0, 10),
      tip: fullSha,
      base: parent || "(root)",
      comparedLabel: parent
        ? `${parent.slice(0, 8)}..${fullSha.slice(0, 8)}`
        : fullSha.slice(0, 8),
      rangeDiff,
      unstaged: "",
      staged: "",
      recentCommits: `${fullSha.slice(0, 8)} ${subject}`,
      files,
      summary,
      tipIsHead: false,
      mode: "commit",
      commitSha: fullSha,
    };
  }

  const { tip, label } = await resolveTip(opts);
  const base = await resolveBase(opts?.baseBranch);

  const tipBranch = (opts?.branch || "").replace(/^origin\//, "").trim();
  if (tipBranch) {
    await execFileAsync(
      "git",
      [
        "fetch",
        "origin",
        `+refs/heads/${tipBranch}:refs/remotes/origin/${tipBranch}`,
        "--quiet",
      ],
      { cwd: repoPath },
    ).catch(() => undefined);
  }

  const headSha = (await gitOk(["rev-parse", "HEAD"]))?.trim() || "";
  let tipRef = tip;
  if (tipBranch && (await revExists(`origin/${tipBranch}`))) {
    tipRef = `origin/${tipBranch}`;
  }
  const tipSha = (await gitOk(["rev-parse", tipRef]))?.trim() || tipRef;
  const tipIsHead = Boolean(headSha && tipSha && headSha === tipSha);

  const range = `${base}...${tipRef}`;
  const comparedLabel = range;

  const baseName = base.replace(/^origin\//, "");
  await execFileAsync("git", ["fetch", "origin", baseName, "--quiet"], {
    cwd: repoPath,
  }).catch(() => undefined);

  let { files, summary, rangeDiff } = await buildFileStats(range);
  if (!rangeDiff.trim() && tipRef !== "HEAD") {
    const fallback = await buildFileStats(`${baseName}...${tipRef}`);
    if (fallback.rangeDiff.trim()) {
      files = fallback.files;
      summary = fallback.summary;
      rangeDiff = fallback.rangeDiff;
    }
  }

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
          tipRef,
          `--grep=#${opts.issueIid}`,
        ])) || "";
    }
    if (!recentCommits.trim()) {
      recentCommits =
        (await gitOk(["log", "-15", "--oneline", `${base}..${tipRef}`])) ||
        (await gitOk(["log", "-10", "--oneline", tipRef])) ||
        "";
    }
  } catch {
    recentCommits = "";
  }

  const curBranch =
    (await gitOk(["branch", "--show-current"]))?.trim() || "(detached)";

  return {
    branch: opts?.branch?.trim() || label || curBranch,
    tip: tipRef,
    base,
    comparedLabel,
    rangeDiff,
    unstaged,
    staged,
    recentCommits: recentCommits.trim(),
    files,
    summary,
    tipIsHead,
    mode: "range",
    commitSha: opts?.commitSha,
  };
}
