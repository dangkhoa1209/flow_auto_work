/**
 * Task-level change summary for Create MR / Merge comments.
 * Prefer full work-branch vs base (not only the tip commit / last agent run).
 */
import { git } from "../../plugins/git/exec.js";

/** Pull the SUMMARY: line from a DONE block; else first useful line. */
export function extractDoneSummaryLine(raw?: string | null): string {
  const t = (raw || "").trim();
  if (!t) return "";
  const labeled = t.match(/^SUMMARY:\s*(.+)$/im);
  if (labeled?.[1]?.trim()) return labeled[1].trim();
  for (const line of t.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (/^(ASSUMPTIONS|RISKS|TESTED)\s*:/i.test(s)) continue;
    return s.replace(/^SUMMARY:\s*/i, "").trim();
  }
  return t.slice(0, 240);
}

async function resolveRef(
  repoPath: string,
  name: string,
): Promise<string | null> {
  const n = name.trim();
  if (!n) return null;
  for (const ref of [`origin/${n}`, n]) {
    try {
      const { stdout } = await git(repoPath, ["rev-parse", "--verify", ref]);
      if (stdout.trim()) return ref;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Files changed on the whole work branch vs base (triple-dot). */
export async function listTaskChangedFiles(opts: {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<string[]> {
  const tip = await resolveRef(opts.repoPath, opts.sourceBranch);
  const base = await resolveRef(opts.repoPath, opts.targetBranch);
  if (!tip || !base) return [];
  try {
    const { stdout } = await git(opts.repoPath, [
      "diff",
      "--name-only",
      "--find-renames",
      `${base}...${tip}`,
    ]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Subjects for known job commit SHAs (oldest → newest when possible). */
export async function listSubjectsForShas(
  repoPath: string,
  shas: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const sha of shas) {
    const s = sha.trim();
    if (!s) continue;
    try {
      const { stdout } = await git(repoPath, [
        "log",
        "-1",
        "--format=%s",
        s,
      ]);
      const subject = stdout.trim();
      if (subject) out.push(subject);
    } catch {
      /* skip missing sha */
    }
  }
  return out;
}

/** Commit subjects on work branch since merge-base with base (oldest → newest). */
export async function listTaskCommitSubjects(opts: {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  /** Fallback when range is empty (e.g. after merge) or refs missing. */
  commitShas?: string[];
  limit?: number;
}): Promise<string[]> {
  const tip = await resolveRef(opts.repoPath, opts.sourceBranch);
  const base = await resolveRef(opts.repoPath, opts.targetBranch);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
  if (tip && base) {
    try {
      const { stdout } = await git(opts.repoPath, [
        "log",
        "--reverse",
        `-n${limit}`,
        "--format=%s",
        `${base}..${tip}`,
      ]);
      const subjects = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (subjects.length) return subjects;
    } catch {
      /* fall through to sha list */
    }
  }
  if (opts.commitShas?.length) {
    return listSubjectsForShas(opts.repoPath, opts.commitShas.slice(-limit));
  }
  return [];
}

/**
 * Human-readable "Thay đổi" body for MR / issue comments.
 * Lead with agent DONE summary when present; if multiple commits, list them all.
 */
export function buildTaskChangeText(opts: {
  issueTitle?: string;
  jobSummary?: string | null;
  commitSubjects?: string[];
  fallback?: string;
}): string {
  const lead =
    extractDoneSummaryLine(opts.jobSummary) ||
    (opts.issueTitle?.trim()
      ? `Hoàn thành: ${opts.issueTitle.trim()}`
      : "") ||
    (opts.fallback || "").trim();

  const commits = (opts.commitSubjects || [])
    .map((s) => s.trim())
    .filter(Boolean);

  // Single commit that duplicates the lead → keep lead only
  if (commits.length <= 1) {
    return lead || commits[0] || "Đã hoàn thành thay đổi trên nhánh work.";
  }

  const bullets = commits.map((s) => `- ${s}`).join("\n");
  if (!lead) return bullets;
  // Avoid duplicating the same one-liner when lead ≈ last commit
  const last = commits[commits.length - 1]!;
  if (lead === last || last.includes(lead) || lead.includes(last)) {
    return bullets;
  }
  return `${lead}\n\nCác commit trong task:\n${bullets}`;
}
