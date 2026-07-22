import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import type { IssueJob } from "../types.js";
import { resolveGitlabToken } from "../workspace/creds.js";

async function gitlabFetch(
  method: string,
  apiPath: string,
): Promise<Response> {
  const config = getConfig();
  const url = `${config.GITLAB_BASE_URL.replace(/\/$/, "")}/api/v4${apiPath}`;
  return fetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN": resolveGitlabToken(),
      "Content-Type": "application/json",
    },
  });
}

export type LinkedIssueSummary = {
  iid: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  description: string;
  linkType?: string;
  source: "issue_links" | "mention";
};

const IID_RE =
  /(?:^|[^A-Za-z0-9_/])#(\d+)\b|(?:gitlab\.com\/[^\s#]+\/-\/(?:issues|work_items)\/)(\d+)/gi;

const MEDIA_EXT =
  "png|jpe?g|gif|webp|svg|bmp|ico|tiff?|heic|mp4|webm|mov|avi|mkv|mp3|wav|ogg|pdf|zip|rar|7z|tar|gz|docx?|xlsx?|pptx?|csv|fig|sketch";

/**
 * Strip images / file attachments from GitLab markdown — agent must not "read" media.
 * Keeps surrounding text; removes markdown/HTML media and bare upload/file URLs.
 */
export function stripMediaAndAttachments(text: string): string {
  if (!text) return "";
  let out = text;

  // Markdown images ![alt](url)
  out = out.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  // HTML <img ...>
  out = out.replace(/<img\b[^>]*>/gi, "");
  // Markdown / HTML links that only point at uploads or media files → drop link, keep label if useful
  out = out.replace(
    /\[([^\]]*)]\(\s*([^)]+)\s*\)/g,
    (_m, label: string, url: string) => {
      const u = String(url).trim();
      if (isMediaOrUploadUrl(u)) {
        const lab = String(label).trim();
        // Keep non-filename labels (e.g. "see screenshot below" rare); drop pure filenames
        if (lab && !looksLikeFilename(lab)) return lab;
        return "";
      }
      return `[${label}](${url})`;
    },
  );
  // Bare GitLab upload paths / URLs
  out = out.replace(
    /https?:\/\/[^\s)]+\/uploads\/[A-Za-z0-9/_%-]+\.[A-Za-z0-9]+/gi,
    "",
  );
  out = out.replace(/\/uploads\/[A-Za-z0-9/_%-]+\.[A-Za-z0-9]+/gi, "");
  // Bare media file URLs
  out = out.replace(
    new RegExp(
      `https?:\\/\\/[^\\s)]+\\.(?:${MEDIA_EXT})(?:\\?[^\\s)]*)?`,
      "gi",
    ),
    "",
  );
  // Collapse leftover empty lines / spaces
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

function isMediaOrUploadUrl(url: string): boolean {
  const u = url.trim();
  if (/\/uploads\//i.test(u)) return true;
  if (new RegExp(`\\.(?:${MEDIA_EXT})(?:\\?|#|$)`, "i").test(u)) return true;
  if (/^data:image\//i.test(u)) return true;
  return false;
}

function looksLikeFilename(label: string): boolean {
  return new RegExp(`\\.(?:${MEDIA_EXT})$`, "i").test(label.trim());
}

export function extractIssueIids(
  text: string,
  excludeIid?: number,
): number[] {
  const found = new Set<number>();
  let m: RegExpExecArray | null;
  const re = new RegExp(IID_RE.source, IID_RE.flags);
  // Still scan raw text so #iid inside alt text is rare; prefer stripped for mentions
  const source = stripMediaAndAttachments(text) || text;
  while ((m = re.exec(source)) !== null) {
    const iid = Number(m[1] || m[2]);
    if (!Number.isFinite(iid) || iid <= 0) continue;
    if (excludeIid !== undefined && iid === excludeIid) continue;
    found.add(iid);
  }
  return [...found];
}

/**
 * Clean Context: drop short/noisy comments; keep technical signal.
 * - Strip images/file attachments first
 * - Drop comments with fewer than 10 words (unless they have strong signal)
 * - Prefer / keep comments with code fences, checklist `- [ ]`, or `#iid` mentions
 * - Drop orchestrator bot noise
 */
export function cleanCommentBodies(bodies: string[]): string[] {
  const BOT_RE =
    /flow_auto_work|Task work 100% by AI|auto-work (started|finished|failed)|Need clarification —|Opened by flow_auto_work/i;
  const CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/;
  const CHECKLIST_RE = /^\s*[-*]\s*\[[ xX]\]/m;
  const MENTION_RE =
    /(?:^|[^A-Za-z0-9_/])#\d+\b|gitlab\.com\/[^\s#]+\/-\/(?:issues|work_items)\/\d+/i;

  type Scored = { body: string; score: number; words: number };
  const scored: Scored[] = [];

  for (const raw of bodies) {
    const body = stripMediaAndAttachments(raw);
    if (!body) continue;
    if (BOT_RE.test(body)) continue;

    const words = body.split(/\s+/).filter(Boolean).length;
    const hasCode = CODE_RE.test(body);
    const hasChecklist = CHECKLIST_RE.test(body);
    const hasMention = MENTION_RE.test(body);
    const strong = hasCode || hasChecklist || hasMention;

    // Drop short chatter unless it carries technical signal
    if (words < 10 && !strong) continue;

    let score = 0;
    if (hasCode) score += 40;
    if (hasChecklist) score += 25;
    if (hasMention) score += 20;
    // Prefer longer technical notes slightly
    score += Math.min(words, 80);
    scored.push({ body: body.slice(0, 1500), score, words });
  }

  scored.sort((a, b) => b.score - a.score);
  // Keep up to 8 highest-signal comments, chronological-ish by re-sorting original order
  const top = scored.slice(0, 8);
  const selected = new Set(top.map((t) => t.body));
  return bodies
    .map((b) => stripMediaAndAttachments(b).slice(0, 1500))
    .filter((b) => b && selected.has(b));
}

async function listIssueNotes(
  projectId: number,
  issueIid: number,
): Promise<string[]> {
  const bodies: string[] = [];
  let page = 1;
  while (page <= 5) {
    const res = await gitlabFetch(
      "GET",
      `/projects/${projectId}/issues/${issueIid}/notes?per_page=100&page=${page}&sort=asc`,
    );
    if (!res.ok) {
      logger.warn("Failed to list issue notes", {
        issueIid,
        status: res.status,
      });
      break;
    }
    const notes = (await res.json()) as Array<{
      body?: string;
      system?: boolean;
    }>;
    if (!notes.length) break;
    for (const n of notes) {
      if (n.system) continue;
      if (n.body?.trim()) bodies.push(n.body);
    }
    if (notes.length < 100) break;
    page += 1;
  }
  return bodies;
}

async function listOfficialIssueLinks(
  projectId: number,
  issueIid: number,
): Promise<LinkedIssueSummary[]> {
  const res = await gitlabFetch(
    "GET",
    `/projects/${projectId}/issues/${issueIid}/links`,
  );
  if (!res.ok) {
    // Some GitLab versions / work items may 404 — non-fatal
    logger.warn("Issue links API unavailable", {
      issueIid,
      status: res.status,
    });
    return [];
  }
  const rows = (await res.json()) as Array<{
    link_type?: string;
    issue?: {
      iid?: number;
      title?: string;
      state?: string;
      web_url?: string;
      labels?: string[];
      description?: string | null;
    };
  }>;

  return rows.flatMap((row) => {
    const issue = row.issue;
    if (!issue?.iid) return [];
    const summary: LinkedIssueSummary = {
      iid: issue.iid,
      title: issue.title ?? `(#${issue.iid})`,
      state: issue.state ?? "unknown",
      url: issue.web_url ?? "",
      labels: issue.labels ?? [],
      description: (issue.description ?? "").slice(0, 4000),
      linkType: row.link_type,
      source: "issue_links",
    };
    return [summary];
  });
}

async function fetchIssueSummary(
  projectId: number,
  iid: number,
  source: LinkedIssueSummary["source"],
): Promise<LinkedIssueSummary | null> {
  const res = await gitlabFetch(
    "GET",
    `/projects/${projectId}/issues/${iid}`,
  );
  if (!res.ok) {
    logger.warn("Failed to fetch linked issue", { iid, status: res.status });
    return null;
  }
  const issue = (await res.json()) as {
    iid: number;
    title: string;
    state: string;
    web_url: string;
    labels?: string[];
    description?: string | null;
  };
  return {
    iid: issue.iid,
    title: issue.title,
    state: issue.state,
    url: issue.web_url,
    labels: issue.labels ?? [],
    description: stripMediaAndAttachments(issue.description ?? "").slice(0, 4000),
    source,
  };
}

/**
 * Collect Linked items + #iid mentions from description/comments.
 */
export async function collectLinkedIssueContext(
  issue: IssueJob,
): Promise<{
  linked: LinkedIssueSummary[];
  commentExcerpts: string[];
  promptBlock: string;
}> {
  const projectId = issue.projectId;
  const selfIid = issue.issueIid;

  const [officialLinks, notes] = await Promise.all([
    listOfficialIssueLinks(projectId, selfIid),
    listIssueNotes(projectId, selfIid),
  ]);

  const mentionText = [
    issue.title,
    stripMediaAndAttachments(issue.description ?? ""),
    ...notes.map((n) => stripMediaAndAttachments(n)),
  ].join("\n");
  const mentionedIids = extractIssueIids(mentionText, selfIid);

  const byIid = new Map<number, LinkedIssueSummary>();
  for (const link of officialLinks) {
    byIid.set(link.iid, link);
  }

  const missing = mentionedIids.filter((iid) => !byIid.has(iid));
  const fetched = await Promise.all(
    missing.slice(0, 15).map((iid) => fetchIssueSummary(projectId, iid, "mention")),
  );
  for (const item of fetched) {
    if (item) byIid.set(item.iid, item);
  }

  const linked = [...byIid.values()].sort((a, b) => a.iid - b.iid);
  const cleaned = cleanCommentBodies(notes);
  const commentExcerpts = cleaned.slice(-8);

  logger.info("Collected linked issue context", {
    issueIid: selfIid,
    linked: linked.map((l) => `#${l.iid}`),
    notesRaw: notes.length,
    notesClean: commentExcerpts.length,
  });

  const promptBlock = formatLinkedContext(linked, commentExcerpts);
  return { linked, commentExcerpts, promptBlock };
}

function formatLinkedContext(
  linked: LinkedIssueSummary[],
  commentExcerpts: string[],
): string {
  const parts: string[] = [];

  if (linked.length) {
    parts.push("## Linked / mentioned issues (auto-loaded from GitLab)");
    for (const item of linked) {
      parts.push(
        [
          `### #${item.iid} — ${item.title}`,
          `- State: ${item.state}`,
          `- Source: ${item.source}${item.linkType ? ` (${item.linkType})` : ""}`,
          item.url ? `- URL: ${item.url}` : "",
          `- Labels: ${item.labels.join(", ") || "(none)"}`,
          "",
          item.description || "(no description)",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  if (commentExcerpts.length) {
    parts.push("## Recent human comments on this issue");
    commentExcerpts.forEach((c, i) => {
      parts.push(`### Comment ${i + 1}\n${c}`);
    });
  }

  return parts.join("\n\n");
}
