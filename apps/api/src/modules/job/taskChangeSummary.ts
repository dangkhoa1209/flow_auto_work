/**
 * Task-level change summary for Create MR description (and related summaries).
 * Prefer job work history (chat DONE + job commit SHAs → code change)
 * over dumping the full branch git-log.
 */
import { git } from "../../plugins/git/exec.js";
import { listChatMessages } from "../../models/chat.js";

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

/**
 * Job-scoped commit lines: `shortSha — subject (files…)`.
 * Uses stored job SHAs only — not the whole branch log.
 */
export async function listJobCommitChangeLines(opts: {
  repoPath: string;
  commitShas?: string[];
  limit?: number;
}): Promise<string[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 30);
  const shas = (opts.commitShas || [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-limit);
  const out: string[] = [];
  for (const sha of shas) {
    try {
      const { stdout: meta } = await git(opts.repoPath, [
        "log",
        "-1",
        "--format=%h\t%s",
        sha,
      ]);
      const [short, subject] = meta.trim().split("\t");
      if (!short) continue;
      let files = "";
      try {
        const { stdout: names } = await git(opts.repoPath, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          sha,
        ]);
        const paths = names
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (paths.length) {
          const shown = paths.slice(0, 4).join(", ");
          files =
            paths.length > 4
              ? ` (${shown}, +${paths.length - 4} files)`
              : ` (${shown})`;
        }
      } catch {
        /* optional */
      }
      out.push(
        `${short} — ${(subject || "").trim() || "(no subject)"}${files}`,
      );
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
 * Work-task history from job chat: agent DONE/summary lines (+ short human asks).
 * Prefer this over raw git-log when building MR / merge comments.
 */
export function extractWorkHistoryFromChat(
  messages: Array<{ role?: string; body?: string | null }>,
  opts?: { limit?: number },
): string[] {
  const limit = Math.min(Math.max(opts?.limit ?? 12, 1), 24);
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const s = raw.trim().replace(/\s+/g, " ");
    if (!s || s.length < 3) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s.length > 200 ? `${s.slice(0, 197)}…` : s);
  };

  for (const m of messages) {
    const body = (m.body || "").trim();
    if (!body) continue;
    if (m.role === "agent" || m.role === "assistant") {
      const summary = extractDoneSummaryLine(body);
      if (summary) push(summary);
    } else if (m.role === "user") {
      // Keep short human work requests as timeline anchors
      const first = body.split("\n").map((l) => l.trim()).find(Boolean) || "";
      if (first && first.length <= 160 && !/^<<<|^```/.test(first)) {
        push(`YC: ${first}`);
      }
    }
  }

  return out.slice(-limit);
}

/** Load chat for a job and extract work-history lines. */
export async function listJobWorkHistory(
  jobId: string,
  opts?: { limit?: number },
): Promise<string[]> {
  try {
    const rows = await listChatMessages({ jobId, limit: 200 });
    return extractWorkHistoryFromChat(rows, opts);
  } catch {
    return [];
  }
}

/**
 * Human-readable "Thay đổi" body for MR / issue comments.
 * Prefer work-task chat history + job commit SHAs → code change;
 * fall back to commit subjects only when history is empty.
 */
export function buildTaskChangeText(opts: {
  issueTitle?: string;
  jobSummary?: string | null;
  /** Agent/human work steps from job chat (preferred). */
  workHistory?: string[];
  /** `shortSha — subject (files)` from job.commitShas (preferred over subjects). */
  commitLines?: string[];
  /** Legacy fallback: plain commit subjects from branch log. */
  commitSubjects?: string[];
  fallback?: string;
}): string {
  const lead =
    extractDoneSummaryLine(opts.jobSummary) ||
    (opts.issueTitle?.trim()
      ? `Hoàn thành: ${opts.issueTitle.trim()}`
      : "") ||
    (opts.fallback || "").trim();

  const history = (opts.workHistory || [])
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      if (!lead) return true;
      return s !== lead && !lead.includes(s) && !s.includes(lead);
    });

  const commitLines = (opts.commitLines || [])
    .map((s) => s.trim())
    .filter(Boolean);

  const parts: string[] = [];
  if (lead) parts.push(lead);

  if (history.length) {
    parts.push(
      `Lịch sử work task:\n${history.map((s) => `- ${s}`).join("\n")}`,
    );
  }

  if (commitLines.length) {
    parts.push(
      `Commit (id → thay đổi):\n${commitLines.map((s) => `- ${s}`).join("\n")}`,
    );
  } else if (!history.length) {
    // Fallback only when no chat history: list subjects (legacy)
    const commits = (opts.commitSubjects || [])
      .map((s) => s.trim())
      .filter(Boolean);
    if (commits.length > 1) {
      const bullets = commits.map((s) => `- ${s}`).join("\n");
      if (lead) {
        const last = commits[commits.length - 1]!;
        if (lead === last || last.includes(lead) || lead.includes(last)) {
          parts.length = 0;
          parts.push(bullets);
        } else {
          parts.push(`Các commit trong task:\n${bullets}`);
        }
      } else {
        parts.push(bullets);
      }
    } else if (!lead && commits[0]) {
      parts.push(commits[0]);
    }
  }

  if (!parts.length) {
    return "Đã hoàn thành thay đổi trên nhánh work.";
  }
  return parts.join("\n\n");
}
