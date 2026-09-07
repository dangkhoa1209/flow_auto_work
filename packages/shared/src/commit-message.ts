/**
 * Commit label helpers for Flow auto / manual commits.
 * - Linked GitHub/GitLab task: `feat #123 Issue title` (or `docs #123 …`)
 * - Ad-hoc / no task: Conventional Commits `type: subject`
 */

export const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "hotfix",
] as const;

export type ConventionalCommitType =
  (typeof CONVENTIONAL_COMMIT_TYPES)[number];

const TYPE_SET = new Set<string>(CONVENTIONAL_COMMIT_TYPES);

const CONVENTIONAL_LINE_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|hotfix)(?:\(([^)]*)\))?!?:\s*(.+)$/i;

/** Phrases that must never land in a commit subject (prompt / chat tone). */
const CONVERSATIONAL_PHRASE_RE =
  /\b(như bạn muốn|như mình muốn|theo ý bạn|theo yêu cầu(?:\s+của\s+bạn)?|as you (?:wanted|asked|requested)|like you wanted|per your request)\b/gi;

/** Leading past-tense / “just did” fillers (VI + EN). */
const PAST_TENSE_PREFIX_RE =
  /^(?:đã|vừa|mới|have|has|had|just)\s+/i;

export type CommitHint = {
  type?: ConventionalCommitType;
  /** Scope from `type(scope):` when present (may be `#123` or a module name). */
  scope?: string | null;
  subject: string;
};

export type FormatConventionalCommitOpts = {
  type: string;
  subject: string;
  /** Prefer explicit scope from agent COMMIT line when set. */
  scope?: string | null;
};

function normalizeType(raw: string | undefined | null): ConventionalCommitType | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  return TYPE_SET.has(t) ? (t as ConventionalCommitType) : undefined;
}

/**
 * Strip conversational / past-tense tone; prefer imperative present subject.
 */
export function sanitizeCommitSubject(raw: string): string {
  let text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  text = text.replace(CONVERSATIONAL_PHRASE_RE, " ");
  // Drop repeated past-tense starters
  for (let i = 0; i < 3; i++) {
    const next = text.replace(PAST_TENSE_PREFIX_RE, "").trim();
    if (next === text) break;
    text = next;
  }
  // "đổi theo N hướng" without technical content → keep remaining words only
  text = text.replace(/\s+/g, " ").trim();

  // Conventional subject: lowercase first letter (unless acronym)
  if (text && /^[A-ZÀ-Ỵ]/.test(text) && !/^[A-Z]{2,}(?:\s|$)/.test(text)) {
    text = text.charAt(0).toLowerCase() + text.slice(1);
  }
  return text.trim();
}

/**
 * Collapse agent DONE / issue title into a short commit subject (≤10 words).
 * Prefer `SUMMARY:` when the text is a full DONE block; always sanitize tone.
 */
export function shortCommitSubject(
  raw: string,
  opts?: { maxWords?: number; fallback?: string },
): string {
  const maxWords = opts?.maxWords ?? 10;
  const fallback = opts?.fallback ?? "code changes";
  let text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;

  const summaryLine = text.match(
    /(?:^|\b)SUMMARY:\s*(.+?)(?:\s+(?:COMMIT|ASSUMPTIONS|RISKS|TESTED)\s*:|$)/i,
  );
  if (summaryLine?.[1]) {
    text = summaryLine[1].trim();
  } else {
    const first = text.split(/[.;!?。]/)[0]?.trim();
    if (first) text = first;
  }

  text = sanitizeCommitSubject(text);
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return fallback;
  return words.slice(0, maxWords).join(" ");
}

/**
 * Parse optional `COMMIT:` line from a DONE block (or free text).
 * Accepts full conventional lines or a bare subject.
 */
export function parseCommitHintFromDone(raw: string | null | undefined): CommitHint | null {
  const text = (raw || "").trim();
  if (!text) return null;

  const lineMatch = text.match(/(?:^|\n)\s*COMMIT:\s*(.+?)(?:\n|$)/i);
  if (!lineMatch?.[1]) return null;
  const line = lineMatch[1].replace(/\s+/g, " ").trim();
  if (!line) return null;

  const conventional = line.match(CONVENTIONAL_LINE_RE);
  if (conventional) {
    return {
      type: normalizeType(conventional[1]),
      scope: conventional[2]?.trim() || null,
      subject: sanitizeCommitSubject(conventional[3] || ""),
    };
  }

  return { subject: sanitizeCommitSubject(line) };
}

/**
 * Linked-task label: `feat #123 Issue title` (space form, not Conventional scope).
 */
export function formatTaskCommit(opts: {
  type?: string;
  issueIid: number;
  title: string;
  fallback?: string;
}): string {
  const type = normalizeType(opts.type) || "feat";
  const title =
    (opts.title || "").replace(/\s+/g, " ").trim() ||
    (opts.fallback || "code changes");
  return `${type} #${opts.issueIid} ${title}`;
}

/**
 * Ad-hoc Conventional Commits: `type: subject` (optional `type(scope): subject`).
 * Does not inject `#iid` — linked tasks use {@link formatTaskCommit} instead.
 */
export function formatConventionalCommit(
  opts: FormatConventionalCommitOpts,
): string {
  const type = normalizeType(opts.type) || "feat";
  const subject =
    sanitizeCommitSubject(opts.subject) || "code changes";

  let scope = (opts.scope || "").trim();
  if (scope) {
    const num = scope.replace(/^#/, "").trim();
    if (/^\d+$/.test(num)) scope = `#${num}`;
    return `${type}(${scope}): ${subject}`;
  }
  return `${type}: ${subject}`;
}

export type BuildCommitMessageInput = {
  /** DONE text or free summary — may include COMMIT: / SUMMARY: */
  whatDone?: string | null;
  /** Fallback when whatDone has no usable subject (e.g. issue title). */
  fallbackTitle?: string | null;
  issueIid?: number | null;
  /** Forced type (e.g. docs phase). */
  defaultType?: string;
  /** Ad-hoc / hotfix sessions default to fix when no COMMIT type. */
  adhoc?: boolean;
  subjectFallback?: string;
};

/**
 * Full auto-commit label from agent DONE + issue context.
 * Linked task → `feat #iid <issue title>`; ad-hoc → Conventional Commits from DONE.
 */
export function buildCommitMessage(input: BuildCommitMessageInput): string {
  const iid =
    input.issueIid != null && input.issueIid > 0 ? input.issueIid : null;

  // GitHub / GitLab job with issue: always feat|docs #id + task title
  if (iid) {
    const type = normalizeType(input.defaultType) || "feat";
    return formatTaskCommit({
      type,
      issueIid: iid,
      title: input.fallbackTitle || "",
      fallback: input.subjectFallback || "code changes",
    });
  }

  const hint = parseCommitHintFromDone(input.whatDone);
  const defaultType =
    normalizeType(input.defaultType) || (input.adhoc ? "fix" : "feat");
  const type = hint?.type || defaultType;
  const rawSubject =
    hint?.subject ||
    input.whatDone?.trim() ||
    input.fallbackTitle?.trim() ||
    "";
  const subject = shortCommitSubject(rawSubject, {
    fallback: input.subjectFallback || "code changes",
  });

  return formatConventionalCommit({
    type,
    subject,
    scope: hint?.scope,
  });
}
