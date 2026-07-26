import { stripMediaAndAttachments } from "../gitlab/linked-context.js";
import type { IssueJob } from "../../types.js";

export type ContextQualityLevel = "good" | "searchable" | "bad";

export type ContextQualityResult = {
  level: ContextQualityLevel;
  /** Human-readable reason (VI) */
  reason: string;
  /** Grep/search anchors for searchable / good */
  anchors: string[];
  /** File / component / model hints for good */
  fileHints: string[];
  /** What is missing when bad */
  missing: string[];
  /** true when reused sticky mark on job (level good) */
  cached?: boolean;
  /** Signals counted (debug) */
  signals: {
    good: string[];
    searchable: string[];
    bad: string[];
    wordCount: number;
  };
};

/** Sticky mark persisted on JobRecord.contextQuality */
export type ContextQualityMark = {
  level: ContextQualityLevel;
  assessedAt: string;
  reason?: string;
  anchors?: string[];
  fileHints?: string[];
};

export function toContextQualityMark(
  result: ContextQualityResult,
): ContextQualityMark {
  return {
    level: result.level,
    assessedAt: new Date().toISOString(),
    reason: result.reason,
    anchors: result.anchors,
    fileHints: result.fileHints,
  };
}

export function qualityFromJobMark(
  mark: ContextQualityMark,
): ContextQualityResult {
  return {
    level: mark.level,
    reason: mark.reason || "Cached context quality mark",
    anchors: mark.anchors || [],
    fileHints: mark.fileHints || [],
    missing: [],
    cached: true,
    signals: { good: [], searchable: [], bad: [], wordCount: 0 },
  };
}

/**
 * Resolve quality for any coding agent call.
 * If job already marked **good** → reuse (no re-assess).
 * Otherwise assess and return fresh result (caller should persist mark).
 */
export function resolveContextQualityForCoding(
  job: {
    contextQuality?: ContextQualityMark;
    issue: IssueJob;
  },
  opts: {
    devNotes?: string;
    chatHuman?: string[];
    /** Extra human text this turn (e.g. follow-up message) */
    extraHuman?: string;
  },
): ContextQualityResult {
  if (job.contextQuality?.level === "good") {
    return qualityFromJobMark(job.contextQuality);
  }
  const chatHuman = [...(opts.chatHuman || [])];
  if (opts.extraHuman?.trim()) chatHuman.push(opts.extraHuman.trim());
  return assessContextQuality({
    issue: job.issue,
    devNotes: opts.devNotes,
    chatHuman,
  });
}

export type ContextQualityInput = {
  issue: IssueJob;
  devNotes?: string;
  /** Recent human chat bodies */
  chatHuman?: string[];
};

const VAGUE_RE =
  /\b(sửa|fix|bug|lỗi|error|chậm|lag|chay|chạy|không\s*hoạt\s*động|không\s*chạy|trắng\s*màn|crash|broken|improve|update|dashboard|làm\s*cho|giống\s*bên|sao\s*cũng\s*được)\b/gi;

const ROUTE_RE =
  /(?:https?:\/\/[^\s)]+|\/(?:api|admin|app|web)\/[^\s,;)"]+|(?:GET|POST|PUT|PATCH|DELETE)\s+\/[^\s]+|route\s*[:=]\s*['`][^'`]+['`])/gi;

const FILE_RE =
  /\b[\w./-]+\.(?:vue|php|ts|tsx|js|jsx|blade\.php|scss|css|mdc?)\b|\b(?:app\/|resources\/|web\/src\/)[\w./-]+/gi;

const MODEL_COLLECTION_RE =
  /\b(?:Model|Eloquent|collection|schema|migration)\s*[:=]?\s*[`']?([A-Za-z][\w]*)[`']?|\b(?:MongoDB|mongo)\s+[A-Za-z][\w]*|\b(?:Employee|Staff|Payroll|Attendance|Salary)[A-Za-z]*\.(?:vue|php|ts)\b|\bcollection\s+[`']?([a-z][\w]*)[`']?/gi;

const COMPONENT_RE =
  /\b([A-Z][A-Za-z0-9]+(?:List|Form|Modal|Table|Page|View|Dialog|Button)\.vue)\b|\bcomponents?\/[\w./-]+\.vue\b/gi;

const IO_RE =
  /\b(?:input|output|payload|response|request|body|params?|expected\s+(?:json|response)|API\s+response)\b/i;

const REPRO_RE =
  /\b(?:steps?\s*to\s*reproduce|tái\s*hiện|các\s*bước|reproduce|repro)\b/i;

const BEHAVIOR_RE =
  /\b(?:current\s*behavior|expected\s*behavior|đang\s*xảy\s*ra|mong\s*đợi|expected|actual|hiện\s*tại)\b/i;

const ERROR_LOG_RE =
  /\b(?:stack\s*trace|Stack\s*trace|ErrorException|SQLSTATE|TypeError|Undefined|at\s+Object\.|console\.(?:error|warn)|Illuminate\\|Vue\s*warn|#\d+\s+[A-Z])/i;

const API_PATH_RE =
  /(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]+)|(\/api\/v?\d*\/[^\s,;")]+)/gi;

const QUOTED_UI_RE = /[«"“]([^"”»]{4,80})[»"”]/g;

const FIELD_RE =
  /\b(?:base_salary|overtime|ot_hours|check_in|check_out|payroll|timesheet|employee_code|staff_id|attendance|sync_\w+|[\w]+_id)\b/gi;

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function uniq(items: string[], max = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const s = raw.trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function matchAll(re: RegExp, text: string): string[] {
  const out: string[] = [];
  const r = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : `${re.flags}g`,
  );
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    out.push(m[0]);
  }
  return out;
}

/**
 * Classify issue+notes+chat into Good / Searchable / Bad context for Run gate.
 */
export function assessContextQuality(
  input: ContextQualityInput,
): ContextQualityResult {
  const desc = stripMediaAndAttachments(input.issue.description || "");
  const notes = (input.devNotes || "").trim();
  const chat = (input.chatHuman || []).map((s) => s.trim()).filter(Boolean);
  const title = (input.issue.title || "").trim();

  const corpus = [title, desc, notes, ...chat].filter(Boolean).join("\n");
  const wc = wordCount(corpus);

  const goodSignals: string[] = [];
  const searchableSignals: string[] = [];
  const badSignals: string[] = [];

  const routes = uniq(matchAll(ROUTE_RE, corpus));
  const files = uniq([
    ...matchAll(FILE_RE, corpus),
    ...matchAll(COMPONENT_RE, corpus),
  ]);
  const models = uniq(matchAll(MODEL_COLLECTION_RE, corpus));
  const apis = uniq(matchAll(API_PATH_RE, corpus).map((s) => s.trim()));
  const quoted = uniq(
    [...corpus.matchAll(QUOTED_UI_RE)]
      .map((m) => m[1]?.trim() || "")
      .filter(Boolean),
  );
  const fields = uniq(matchAll(FIELD_RE, corpus));

  if (routes.length) {
    goodSignals.push(`route/url: ${routes.slice(0, 3).join(", ")}`);
  }
  if (files.length) {
    goodSignals.push(`files: ${files.slice(0, 5).join(", ")}`);
  }
  if (models.length) {
    goodSignals.push(`model/collection: ${models.slice(0, 3).join(", ")}`);
  }
  if (IO_RE.test(corpus)) {
    goodSignals.push("input/output or API payload mentioned");
  }
  if (REPRO_RE.test(corpus)) goodSignals.push("steps to reproduce");
  if (BEHAVIOR_RE.test(corpus)) {
    goodSignals.push("current vs expected behavior");
  }
  if (ERROR_LOG_RE.test(corpus)) goodSignals.push("error log / stack trace");

  // Clear Dev Notes alone can qualify as Good (technical + long enough)
  const notesWc = wordCount(notes);
  const notesHasTech =
    matchAll(FILE_RE, notes).length > 0 ||
    matchAll(COMPONENT_RE, notes).length > 0 ||
    matchAll(ROUTE_RE, notes).length > 0 ||
    matchAll(MODEL_COLLECTION_RE, notes).length > 0 ||
    matchAll(FIELD_RE, notes).length > 0 ||
    IO_RE.test(notes) ||
    REPRO_RE.test(notes) ||
    BEHAVIOR_RE.test(notes) ||
    ERROR_LOG_RE.test(notes) ||
    /(?:docs\/|\.mdc?\b|AGENTS\.md|virtual\s*scroll|index\b|migration|controller|service|repository)/i.test(
      notes,
    );
  const clearDevNotes =
    notesWc >= 25 &&
    notesHasTech &&
    matchAll(VAGUE_RE, notes).length < Math.max(2, Math.floor(notesWc / 15));
  if (clearDevNotes) {
    goodSignals.push(`clear Dev Notes (~${notesWc} từ, có tín hiệu kỹ thuật)`);
  }

  const bugTriad =
    REPRO_RE.test(corpus) &&
    BEHAVIOR_RE.test(corpus) &&
    (ERROR_LOG_RE.test(corpus) || files.length > 0);
  const featureGood =
    (files.length > 0 || models.length > 0) &&
    (routes.length > 0 || IO_RE.test(corpus) || notes.length > 40);

  if (apis.length) {
    searchableSignals.push(`api: ${apis.slice(0, 3).join(", ")}`);
  }
  if (quoted.length) {
    searchableSignals.push(
      `ui-text: ${quoted
        .slice(0, 3)
        .map((q) => `"${q}"`)
        .join(", ")}`,
    );
  }
  if (fields.length) {
    searchableSignals.push(`fields: ${fields.slice(0, 5).join(", ")}`);
  }
  if (routes.length && !files.length) {
    searchableSignals.push(`route-anchor: ${routes[0]}`);
  }

  if (wc < 20) {
    badSignals.push(`mô tả quá ngắn (${wc} từ, cần ≥ 20)`);
  }
  const vagueHits = matchAll(VAGUE_RE, corpus);
  if (
    vagueHits.length >= 2 &&
    goodSignals.length === 0 &&
    searchableSignals.length === 0
  ) {
    badSignals.push(`từ ngữ chung chung: ${uniq(vagueHits, 5).join(", ")}`);
  }
  if (
    wc < 40 &&
    goodSignals.length === 0 &&
    searchableSignals.length === 0 &&
    /^(sửa|fix|update|improve)/i.test(title)
  ) {
    badSignals.push("title kiểu lệnh chung, thiếu chi tiết kỹ thuật");
  }

  const missing: string[] = [];
  if (!routes.length) {
    missing.push(
      "URL / route của màn hình hoặc API (vd. /admin/employees, POST /api/…)",
    );
  }
  if (!files.length && !models.length) {
    missing.push(
      "Tên file / Component / Model / Collection liên quan (vd. EmployeeList.vue)",
    );
  }
  if (!REPRO_RE.test(corpus) && !IO_RE.test(corpus)) {
    missing.push(
      "Với bug: Steps to reproduce; với feature: Input/Output mong muốn",
    );
  }
  if (
    !BEHAVIOR_RE.test(corpus) &&
    !ERROR_LOG_RE.test(corpus) &&
    !IO_RE.test(corpus)
  ) {
    missing.push(
      "Current vs Expected behavior, hoặc error log / stack trace",
    );
  }

  let level: ContextQualityLevel;
  let reason: string;

  if (bugTriad || featureGood || clearDevNotes || goodSignals.length >= 3) {
    level = "good";
    reason = clearDevNotes
      ? "Dev Notes rõ ràng (đủ dài + tín hiệu kỹ thuật) — coi như Good Context, CODE PHASE trực tiếp."
      : "Đủ ngữ cảnh kỹ thuật (route/file/model hoặc bug có tái hiện + expected + log) — CODE PHASE trực tiếp.";
  } else if (
    searchableSignals.length >= 1 ||
    (goodSignals.length >= 1 && wc >= 20)
  ) {
    level = "searchable";
    reason =
      "Có mỏ neo để search (UI text / field / API / route) nhưng chưa chỉ rõ file — agent phải grep trước khi code.";
  } else if (
    wc < 20 ||
    badSignals.length > 0 ||
    goodSignals.length + searchableSignals.length === 0
  ) {
    level = "bad";
    reason =
      "Context mù mờ — thiếu route, file, bước tái hiện hoặc chi tiết kỹ thuật. Không chạy agent để tránh tốn token.";
  } else {
    level = "searchable";
    reason =
      "Có một phần tín hiệu kỹ thuật — yêu cầu search trước khi sửa.";
  }

  if (level !== "good" && (bugTriad || featureGood || clearDevNotes)) {
    level = "good";
    reason = clearDevNotes
      ? "Dev Notes rõ ràng — coi như Good Context."
      : "Đủ ngữ cảnh kỹ thuật — CODE PHASE trực tiếp.";
  }

  const anchors = uniq([
    ...quoted,
    ...fields,
    ...apis,
    ...routes,
    ...models,
  ]);
  const fileHints = uniq([...files, ...models]);

  return {
    level,
    reason,
    anchors,
    fileHints,
    missing: level === "bad" ? missing.slice(0, 5) : [],
    signals: {
      good: goodSignals,
      searchable: searchableSignals,
      bad: badSignals,
      wordCount: wc,
    },
  };
}

/** Block for agent prompt when level is good or searchable. */
export function formatContextQualityForPrompt(
  result: ContextQualityResult,
): string {
  if (result.level === "bad") return "";

  if (result.level === "good") {
    const files =
      result.fileHints.length > 0
        ? result.fileHints.map((f) => `- \`${f}\``).join("\n")
        : "(use paths explicitly named in the requirements above)";
    const anchors =
      result.anchors.length > 0
        ? result.anchors.map((a) => `- ${a}`).join("\n")
        : "";
    return `# CONTEXT QUALITY: GOOD (skip broad search)
This task has enough technical context. Do **NOT** scan the whole codebase.
Open / edit the files and symbols named in the requirements first:
${files}
${anchors ? `\nKnown anchors:\n${anchors}\n` : ""}
Go straight to implementation after reading those targets. Only search if a named path is missing.
Reality check: these hints come from the ticket and may be stale. If a named file/symbol does not exist or clearly does not match the described behavior, do a targeted search for the right place instead of forcing the edit into the named file — and if you end up somewhere else, mention it under ASSUMPTIONS in the DONE block.
`;
  }

  const anchors =
    result.anchors.length > 0
      ? result.anchors.map((a) => `- \`${a}\``).join("\n")
      : "- (derive keywords from the issue title/description)";
  return `# CONTEXT QUALITY: SEARCHABLE (search before code)
Context has technical anchors but not exact file paths.
**Before writing code**, use search tools (grep / find) for these keywords, open the matching files, then implement:
${anchors}

Do not guess file locations. Cap exploration to a few targeted searches (1–2 rounds), then code.
If after ~2 rounds the anchors do NOT lead to the code the ticket describes (no match, or several equally plausible places), do NOT guess-edit. Use NEED_CLARIFICATION and include: the keywords/paths you searched, the candidates you found, and a numbered question with options so the human can point to the right place in one reply.
`;
}

/** Chat / lastQuestion body when blocking Bad Context (Vietnamese). */
export function formatBadContextChatMessage(
  result: ContextQualityResult,
  issueIid: number,
): string {
  const missing =
    result.missing.length > 0
      ? result.missing.map((m, i) => `${i + 1}. ${m}`).join("\n")
      : "1. URL / route\n2. Steps to reproduce hoặc Input/Output\n3. File/Component hoặc error log";

  return `⛔ **Bad Context — đã dừng Run** (không gọi Cursor Agent)

Issue #${issueIid} chưa đủ ngữ cảnh kỹ thuật. Chạy agent lúc này sẽ tốn token và dễ sửa sai chỗ.

**Lý do:** ${result.reason}
${result.signals.wordCount ? `**Độ dài corpus:** ~${result.signals.wordCount} từ` : ""}

**Vui lòng bổ sung (Dev Notes hoặc chat rồi Run lại):**
${missing}

**Gợi ý Good Context:**
- Feature: route/URL + Input/Output + Model/Component (vd. \`EmployeeList.vue\`)
- Bug: Steps to reproduce + Current vs Expected + error log/stack trace
- **Hoặc** Dev Notes rõ ràng (≥ ~25 từ + tín hiệu kỹ thuật: file/route/field/I/O/repro…)`;
}

/** Standards text for UI modal (kept in sync with classifier). */
export const CONTEXT_QUALITY_STANDARDS = {
  good: [
    "Feature: route/URL + Input/Output + Model/Component (e.g. EmployeeList.vue)",
    "Bug: Steps to reproduce + Current vs Expected + error log/stack trace",
    "Or clear Dev Notes (≥ ~25 words + technical signals: file/route/field/I/O/repro/docs)",
  ],
  searchable: [
    "Has search anchors: UI text, field name, API path, or route — but no exact file yet",
    "Agent must grep/search before coding",
  ],
  bad: [
    "Vague title / generic description only — missing route, file, or repro steps",
    "Do not run Cursor Agent — add Dev Notes or chat, then Run again",
  ],
} as const;
