/**
 * Task-level change summary for Create MR / Merge comments.
 * Outcome from the work chat (done / not-done / explain) — not a transcript
 * and not a git-log dump.
 */
import { git } from "../../plugins/git/exec.js";
import { listChatMessages } from "../../models/chat.js";

/** Pull the SUMMARY: line from a DONE block; else first useful line. */
export function extractDoneSummaryLine(raw?: string | null): string {
  const t = (raw || "").trim();
  if (!t) return "";
  const labeled = t.match(/^SUMMARY:\s*(.+)$/im);
  if (labeled?.[1]?.trim()) {
    const s = labeled[1].trim();
    if (!isWorkChatter(s)) return s;
  }
  for (const line of t.split("\n")) {
    const s = line.trim().replace(/^SUMMARY:\s*/i, "").trim();
    if (!s) continue;
    if (/^(ASSUMPTIONS|RISKS|TESTED)\s*:/i.test(s)) continue;
    if (isWorkChatter(s)) continue;
    return s;
  }
  return "";
}

/** Chat closers / confirmations — not merge-comment material. */
export function isWorkChatter(raw: string): boolean {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return true;
  if (/^yc:/i.test(s)) return true;
  if (/^merge branch\b/i.test(s)) return true;
  const t = s.toLowerCase();
  if (/\bworking tree\b/.test(t)) return true;
  if (/^đúng[ —–\-,.]/.test(t)) return true;
  if (/\bdone task\b/.test(t)) return true;
  if (/\bđúng ko\b|\bđúng không\b/.test(t)) return true;
  if (/đã xong trên branch/.test(t)) return true;
  if (/^(ok|oke|okay|vâng|ừ|uh|yes|done)[.!?]*$/i.test(s)) return true;
  return false;
}

export type WorkOutcomeBucket = "done" | "not_done" | "note";

/** Classify an agent outcome line for merge / MR comments. */
export function classifyWorkOutcome(text: string): WorkOutcomeBucket {
  const t = text.toLowerCase();
  if (
    /không làm|không trigger|không đụng|out of scope|not implemented/.test(
      t,
    ) ||
    /không tính lại/.test(t) ||
    /chỉ gán cờ/.test(t)
  ) {
    return "not_done";
  }
  if (
    /^đã(\s|$)/.test(t) ||
    /đã (bỏ|siết|sửa|thêm|gỡ|làm|cập nhật)(\s|$)/.test(t) ||
    /^(bỏ|sửa|thêm|gỡ|siết|gộp|sinh|cập nhật|fix|feat)(\s|$)/i.test(t)
  ) {
    return "done";
  }
  return "note";
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
 * Agent outcome lines from job chat (done / not-done / explain).
 * Skips human YC transcripts and chat closers.
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
    if (!s || s.length < 3 || isWorkChatter(s)) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s.length > 200 ? `${s.slice(0, 197)}…` : s);
  };

  for (const m of messages) {
    if (m.role !== "agent" && m.role !== "assistant") continue;
    const body = (m.body || "").trim();
    if (!body) continue;
    push(extractDoneSummaryLine(body));
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
 * Merge / MR "Thay đổi" body: what was done, skipped, or explained.
 * Not a chat transcript and not a commit dump.
 */
export function buildTaskChangeText(opts: {
  issueTitle?: string;
  jobSummary?: string | null;
  /** Agent outcome lines from job chat (preferred). */
  workHistory?: string[];
  /** Ignored — kept so callers need not change. */
  commitLines?: string[];
  /** Ignored — kept so callers need not change. */
  commitSubjects?: string[];
  fallback?: string;
}): string {
  const lead = extractDoneSummaryLine(opts.jobSummary);

  const history = (opts.workHistory || [])
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s && !isWorkChatter(s))
    .filter((s) => {
      if (!lead) return true;
      return s !== lead && !lead.includes(s) && !s.includes(lead);
    });

  const done: string[] = [];
  const notDone: string[] = [];
  const notes: string[] = [];
  for (const s of history) {
    const bucket = classifyWorkOutcome(s);
    if (bucket === "done") done.push(s);
    else if (bucket === "not_done") notDone.push(s);
    else notes.push(s);
  }

  const bullets = (items: string[]) => items.map((s) => `- ${s}`).join("\n");
  const parts: string[] = [];
  if (lead) parts.push(lead);
  if (done.length) parts.push(`**Đã làm**\n${bullets(done)}`);
  if (notDone.length) parts.push(`**Không làm**\n${bullets(notDone)}`);
  if (notes.length) parts.push(`**Giải thích**\n${bullets(notes)}`);

  if (parts.length) return parts.join("\n\n");

  const title = opts.issueTitle?.trim();
  if (title) return `Hoàn thành: ${title}`;
  return (opts.fallback || "").trim() || "Đã hoàn thành thay đổi trên nhánh work.";
}
