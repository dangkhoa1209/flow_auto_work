import type { BuildStatus } from "./types.js";

/** Keywords that should surface a warning section and force fail on exit 0. */
export const BUILD_LOG_FAIL_KEYWORDS = [
  {
    id: "rsync_error",
    label: "rsync error",
    pattern: /rsync\s+error/i,
  },
] as const;

export type BuildLogKeywordHit = {
  keywordId: string;
  label: string;
  /** Contiguous log paragraph around the match. */
  section: string;
};

const MAX_SECTION_CHARS = 4000;
const CONTEXT_BEFORE = 8;
const CONTEXT_AFTER = 3;

function isBlank(line: string): boolean {
  return !line.trim();
}

/**
 * Extract a paragraph around matching indices: from the last blank line
 * before the first hit (capped) through the next blank after the last hit.
 */
export function extractLogSection(
  lines: string[],
  matchIndexes: number[],
): string {
  if (!matchIndexes.length || !lines.length) return "";
  const first = Math.min(...matchIndexes);
  const last = Math.max(...matchIndexes);

  let start = first;
  for (let i = first - 1; i >= 0 && first - i <= CONTEXT_BEFORE; i--) {
    if (isBlank(lines[i])) break;
    start = i;
  }

  let end = last;
  for (let i = last + 1; i < lines.length && i - last <= CONTEXT_AFTER; i++) {
    if (isBlank(lines[i])) break;
    end = i;
  }

  let section = lines.slice(start, end + 1).join("\n").trim();
  if (section.length > MAX_SECTION_CHARS) {
    section = `${section.slice(0, MAX_SECTION_CHARS)}\n…`;
  }
  return section;
}

/** Find fail-keyword hits and their surrounding log sections. */
export function findBuildLogKeywordHits(lines: string[]): BuildLogKeywordHit[] {
  const hits: BuildLogKeywordHit[] = [];
  for (const kw of BUILD_LOG_FAIL_KEYWORDS) {
    const indexes: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (kw.pattern.test(lines[i])) indexes.push(i);
    }
    if (!indexes.length) continue;
    const section = extractLogSection(lines, indexes);
    if (!section) continue;
    hits.push({ keywordId: kw.id, label: kw.label, section });
  }
  return hits;
}

/** Join hit sections for UI / persistence (undefined when no hits). */
export function warningMessageFromLogLines(
  lines: string[],
): string | undefined {
  const hits = findBuildLogKeywordHits(lines);
  if (!hits.length) return undefined;
  return hits.map((h) => h.section).join("\n\n");
}

/** True if a single log line matches any fail keyword. */
export function lineMatchesBuildFailKeyword(line: string): boolean {
  return BUILD_LOG_FAIL_KEYWORDS.some((kw) => kw.pattern.test(line));
}

export type LogKeywordResolution = {
  status: BuildStatus;
  /** Short reason stored on the job (and shown as error). */
  errorMessage?: string;
  /** Full log section for UI warning banner. */
  warningMessage?: string;
  /** True when exit 0 was overridden because of a keyword hit. */
  forcedFail: boolean;
};

/**
 * If the build log contains fail keywords (e.g. "rsync error"):
 * - attach `warningMessage` with the matching section
 * - force `failed` when the process would otherwise be `success`
 */
export function resolveBuildStatusFromLogKeywords(
  status: BuildStatus,
  logLines: string[],
  existingErrorMessage?: string,
): LogKeywordResolution {
  const hits = findBuildLogKeywordHits(logLines);
  if (!hits.length) {
    return {
      status,
      errorMessage: existingErrorMessage,
      forcedFail: false,
    };
  }

  const warningMessage = warningMessageFromLogLines(logLines)!;
  const labels = hits.map((h) => h.label).join(", ");
  const detected = `Detected ${labels} in build log`;

  if (status === "success") {
    return {
      status: "failed",
      errorMessage: detected,
      warningMessage,
      forcedFail: true,
    };
  }

  const errorMessage =
    existingErrorMessage && existingErrorMessage.trim()
      ? `${existingErrorMessage} — ${detected}`
      : detected;

  return {
    status,
    errorMessage,
    warningMessage,
    forcedFail: false,
  };
}
