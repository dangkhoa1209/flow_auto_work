import { logger } from "../../logger.js";
import { stripMediaAndAttachments } from "./linked-context.js";

const MAX_ISSUES = 3;
const MAX_DESC = 8000;
const MAX_NOTES = 12;
const MAX_NOTE = 800;

export type BaIssueRef = {
  iid: number;
  gitlabPath: string;
};

export type BaIssueSnapshot = {
  iid: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  description: string;
  notes: Array<{ author: string; createdAt: string; body: string }>;
};

const ISSUE_URL_RE =
  /https?:\/\/[^/\s)]+\/(.+?)\/-\/(?:issues|work_items)\/(\d+)/gi;
const HASH_IID_RE = /(?:^|[^A-Za-z0-9_/])#(\d+)\b/g;
const TALK_IID_RE =
  /\b(?:issue|task|ticket|iid|id)\s*[#:]?\s*(\d+)\b/gi;

/** Parse GitLab issue URLs, `#123`, or `issue/task/ticket 123` from chat text. */
export function extractBaIssueRefs(
  text: string,
  defaultGitlabPath: string,
): BaIssueRef[] {
  const fallback = defaultGitlabPath.trim().replace(/^\/+|\/+$/g, "");
  const byIid = new Map<number, BaIssueRef>();

  const take = (rawIid: string, pathFromUrl?: string) => {
    const iid = Number(rawIid);
    if (!Number.isFinite(iid) || iid <= 0) return;
    const gitlabPath = (pathFromUrl || fallback)
      .trim()
      .replace(/^\/+|\/+$/g, "");
    if (!gitlabPath) return;
    const prev = byIid.get(iid);
    if (prev && !pathFromUrl) return;
    byIid.set(iid, { iid, gitlabPath });
  };

  let m: RegExpExecArray | null;
  const urlRe = new RegExp(ISSUE_URL_RE.source, ISSUE_URL_RE.flags);
  while ((m = urlRe.exec(text)) !== null) {
    take(m[2], decodePath(m[1]));
  }
  const hashRe = new RegExp(HASH_IID_RE.source, HASH_IID_RE.flags);
  while ((m = hashRe.exec(text)) !== null) {
    take(m[1]);
  }
  const talkRe = new RegExp(TALK_IID_RE.source, TALK_IID_RE.flags);
  while ((m = talkRe.exec(text)) !== null) {
    take(m[1]);
  }

  return [...byIid.values()].slice(0, MAX_ISSUES);
}

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw).replace(/^\/+|\/+$/g, "");
  } catch {
    return raw.replace(/^\/+|\/+$/g, "");
  }
}

async function baGitlabGet(
  host: string,
  token: string,
  apiPath: string,
): Promise<Response> {
  const base = host.replace(/\/$/, "");
  return fetch(`${base}/api/v4${apiPath}`, {
    method: "GET",
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
    },
  });
}

async function fetchIssueNotes(
  host: string,
  token: string,
  projectId: number,
  iid: number,
): Promise<BaIssueSnapshot["notes"]> {
  const res = await baGitlabGet(
    host,
    token,
    `/projects/${projectId}/issues/${iid}/notes?per_page=50&sort=desc`,
  );
  if (!res.ok) return [];
  const batch = (await res.json()) as Array<{
    body?: string;
    system?: boolean;
    created_at?: string;
    author?: { username?: string; name?: string };
  }>;
  const notes: BaIssueSnapshot["notes"] = [];
  for (const n of batch) {
    if (n.system) continue;
    const body = stripMediaAndAttachments(n.body ?? "").slice(0, MAX_NOTE);
    if (!body) continue;
    notes.push({
      author: n.author?.username || n.author?.name || "unknown",
      createdAt: n.created_at ?? "",
      body,
    });
    if (notes.length >= MAX_NOTES) break;
  }
  return notes.reverse();
}

export async function fetchBaIssueSnapshot(
  opts: {
    gitlabHost: string;
    token: string;
    ref: BaIssueRef;
  },
): Promise<BaIssueSnapshot> {
  const project = encodeURIComponent(opts.ref.gitlabPath);
  const res = await baGitlabGet(
    opts.gitlabHost,
    opts.token,
    `/projects/${project}/issues/${opts.ref.iid}`,
  );
  if (!res.ok) {
    throw new Error(
      `GitLab #${opts.ref.iid} (${opts.ref.gitlabPath}) HTTP ${res.status}`,
    );
  }
  const issue = (await res.json()) as {
    iid: number;
    project_id: number;
    title: string;
    description?: string | null;
    state: string;
    web_url: string;
    labels?: string[];
    assignees?: Array<{ username?: string; name?: string }>;
  };
  const notes = await fetchIssueNotes(
    opts.gitlabHost,
    opts.token,
    issue.project_id,
    issue.iid,
  );
  return {
    iid: issue.iid,
    title: issue.title,
    state: issue.state,
    url: issue.web_url,
    labels: issue.labels ?? [],
    assignees: (issue.assignees ?? [])
      .map((a) => a.username || a.name)
      .filter((x): x is string => Boolean(x)),
    description: stripMediaAndAttachments(issue.description ?? "").slice(
      0,
      MAX_DESC,
    ),
    notes,
  };
}

export async function loadBaGitlabTaskBlock(opts: {
  gitlabHost: string;
  gitlabPath: string;
  token: string | null;
  texts: string[];
}): Promise<{ refs: BaIssueRef[]; block: string }> {
  const combined = opts.texts.filter(Boolean).join("\n");
  const refs = extractBaIssueRefs(combined, opts.gitlabPath);
  if (!refs.length) return { refs, block: "" };
  if (!opts.token?.trim()) {
    return {
      refs,
      block: `## GitLab task (chỉ đọc)\nKhông kéo được task ${refs.map((r) => `#${r.iid}`).join(", ")} — project chưa có PAT. Dán nội dung task vào chat nếu cần.`,
    };
  }

  const parts: string[] = [];
  for (const ref of refs) {
    try {
      const snap = await fetchBaIssueSnapshot({
        gitlabHost: opts.gitlabHost,
        token: opts.token,
        ref,
      });
      parts.push(formatBaIssueSnapshot(snap));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("BA GitLab issue read failed", {
        iid: ref.iid,
        path: ref.gitlabPath,
        err: msg,
      });
      parts.push(
        `### #${ref.iid}\nKhông đọc được issue này (${msg.replace(/glpat-[A-Za-z0-9_-]+/g, "glpat-***")}).`,
      );
    }
  }

  return {
    refs,
    block: `## GitLab task (chỉ đọc — hệ thống đã kéo sẵn)
Dùng nội dung dưới để trả lời / phân tích. **Không** comment, không sửa issue, không gọi GitLab API / MCP.

${parts.join("\n\n")}`,
  };
}

export function formatBaIssueSnapshot(snap: BaIssueSnapshot): string {
  const labels = snap.labels.length ? snap.labels.join(", ") : "—";
  const assignees = snap.assignees.length ? snap.assignees.join(", ") : "—";
  const notes = snap.notes.length
    ? snap.notes
        .map((n) => `- @${n.author}${n.createdAt ? ` (${n.createdAt.slice(0, 10)})` : ""}: ${n.body}`)
        .join("\n")
    : "—";
  return `### #${snap.iid} — ${snap.title}
State: ${snap.state}
Labels: ${labels}
Assignees: ${assignees}
URL: ${snap.url}

#### Mô tả
${snap.description || "—"}

#### Comment
${notes}`;
}
