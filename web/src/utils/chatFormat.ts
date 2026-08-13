import { marked } from "marked";
import { API } from "@/api/endpoints";
import {
  getAccessToken,
  loadPersistedAuth,
} from "@/api/tokenStorage";

marked.setOptions({
  gfm: true,
  breaks: true,
});

function gitlabProjectBase(issueUrl: string): string | null {
  try {
    const u = new URL(issueUrl);
    const m = u.pathname.match(
      /^(.*?)\/-\/(?:issues|work_items|merge_requests)\//,
    );
    if (m) return `${u.origin}${m[1]}`;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Browser <img> cannot send Authorization / GitLab cookies (SameSite).
 * Proxy via our API which downloads through GitLab REST uploads API + PAT.
 */
function toGitlabFileProxy(absoluteUrl: string): string {
  const persisted = loadPersistedAuth();
  const qs = new URLSearchParams({ u: absoluteUrl });
  if (persisted.username) qs.set("user", persisted.username);
  if (persisted.projectId) qs.set("project", persisted.projectId);
  const access = getAccessToken();
  if (access) qs.set("access_token", access);
  return `${API.gitlab.file}?${qs.toString()}`;
}

function absolutizeUploadPath(path: string, issueUrl?: string | null): string | null {
  if (!path.startsWith("/uploads/")) return null;
  if (!issueUrl) return null;
  const base = gitlabProjectBase(issueUrl);
  if (!base) return null;
  return `${base}${path}`;
}

function rewriteUploadMarkdown(s: string, issueUrl?: string | null): string {
  // ![alt](/uploads/…) or ![alt](https://gitlab…/uploads/…)
  return s.replace(
    /(!\[[^\]]*\]\()([^)\s]+)(\))/g,
    (_m, a: string, url: string, c: string) => {
      let full = url;
      if (url.startsWith("/uploads/")) {
        const abs = absolutizeUploadPath(url, issueUrl);
        if (!abs) return `${a}${url}${c}`;
        full = abs;
      }
      if (!/\/uploads\//i.test(full)) return `${a}${url}${c}`;
      if (full.startsWith("/api/gitlab/file?")) return `${a}${url}${c}`;
      try {
        const parsed = new URL(full);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return `${a}${url}${c}`;
        }
        return `${a}${toGitlabFileProxy(full)}${c}`;
      } catch {
        return `${a}${url}${c}`;
      }
    },
  );
}

function rewriteUploadHtml(html: string, issueUrl?: string | null): string {
  return html.replace(
    /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi,
    (_m, a: string, src: string, c: string) => {
      if (src.startsWith("/api/gitlab/file?")) return `${a}${src}${c}`;
      let full = src;
      if (src.startsWith("/uploads/")) {
        const abs = absolutizeUploadPath(src, issueUrl);
        if (!abs) return `${a}${src}${c}`;
        full = abs;
      }
      if (!/\/uploads\//i.test(full)) return `${a}${src}${c}`;
      try {
        return `${a}${toGitlabFileProxy(full)}${c}`;
      } catch {
        return `${a}${src}${c}`;
      }
    },
  );
}

/** Count GFM table cells in a pipe row. */
function countPipeCells(line: string): number {
  const t = line.trim();
  if (!t.includes("|")) return 0;
  const parts = t.split("|");
  // "| a | b |" → ["", " a ", " b ", ""] → 2 cells
  const inner =
    t.startsWith("|") && t.endsWith("|")
      ? parts.slice(1, -1)
      : parts.filter((p) => p.length);
  return inner.length;
}

/**
 * Fix common LLM table mistakes: separator with fewer columns than the header
 * (e.g. `|---|` under a 2-column header) so marked can render a real table.
 */
export function repairMarkdownTables(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const trimmed = line.trim();
    if (
      prev &&
      /^\|.+\|$/.test(prev.trim()) &&
      /^\|[\s:|-]+\|$/.test(trimmed)
    ) {
      const headerCells = countPipeCells(prev);
      const sepCells = countPipeCells(line);
      if (headerCells >= 2 && sepCells > 0 && sepCells < headerCells) {
        out.push(
          `|${Array.from({ length: headerCells }, () => " --- ").join("|")}|`,
        );
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function wrapChatTables(html: string): string {
  return html
    .replace(/<table\b/gi, '<div class="chat-md-table-wrap"><table')
    .replace(/<\/table>/gi, "</table></div>");
}

/** Strip machine markers + GitLab markdown quirks. */
export function cleanMarkdownBody(raw: string, issueUrl?: string | null): string {
  let s = String(raw || "");
  s = s.replace(/<<<\s*DONE\s*>>>/gi, "");
  s = s.replace(/<<<\s*NEED_CLARIFICATION\s*>>>[\s\S]*?(?=<<<|$)/gi, "");
  s = s.replace(/<<<\s*DOCS_READY\s*>>>[\s\S]*?(?=<<<|$)/gi, "");
  // GitLab image size suffix: ![x](/uploads/…){width="362" height="343"}
  s = s.replace(/\{width="?\d+"?\s*height="?\d+"?\}/gi, "");
  s = rewriteUploadMarkdown(s, issueUrl);
  s = repairMarkdownTables(s);
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** @deprecated use cleanMarkdownBody */
export function cleanAgentChatBody(raw: string): string {
  return cleanMarkdownBody(raw);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Basic sanitize: drop script/iframe/on* after marked. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

export function renderChatHtml(
  raw: string,
  opts?: { markdown?: boolean; issueUrl?: string | null },
): string {
  const cleaned = cleanMarkdownBody(raw, opts?.issueUrl);
  if (!cleaned) return "";
  if (opts?.markdown === false) {
    return escapeHtml(cleaned).replace(/\n/g, "<br>");
  }
  let html = marked.parse(cleaned, { async: false }) as string;
  html = wrapChatTables(html);
  html = rewriteUploadHtml(html, opts?.issueUrl);
  return sanitizeHtml(html);
}
