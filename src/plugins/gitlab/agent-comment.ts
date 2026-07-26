import { commentOnIssue } from "./client.js";
import { logger } from "../../logger.js";

export const AI_GENERATED_MARKER = "AI-Generated";

const COMMENT_BLOCK_RE =
  /<<<GITLAB_COMMENT>>>\s*([\s\S]*?)\s*<<<END_GITLAB_COMMENT>>>/gi;

/** Ensure comment body starts with AI-Generated (idempotent). */
export function withAiGeneratedMarker(body: string): string {
  const t = body.trim();
  if (!t) return AI_GENERATED_MARKER;
  if (/^AI[- ]?Generated\b/i.test(t)) return t;
  return `${AI_GENERATED_MARKER}\n\n${t}`;
}

/** Extract comment bodies the agent asked Flow to post on GitLab. */
export function extractGitlabCommentBodies(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(COMMENT_BLOCK_RE.source, COMMENT_BLOCK_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (body) out.push(body);
  }
  return out;
}

export function stripGitlabCommentBlocks(text: string): string {
  return text
    .replace(new RegExp(COMMENT_BLOCK_RE.source, COMMENT_BLOCK_RE.flags), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Post any <<<GITLAB_COMMENT>>> blocks from agent output onto the issue.
 * Always prefixes AI-Generated. No-op for adhoc (issueIid <= 0).
 */
export async function postAgentGitlabComments(opts: {
  projectId: number | string;
  issueIid: number;
  agentText: string;
  jobId?: string;
}): Promise<{ posted: number; bodies: string[] }> {
  if (!opts.issueIid || opts.issueIid <= 0) {
    return { posted: 0, bodies: [] };
  }
  const bodies = extractGitlabCommentBodies(opts.agentText);
  if (!bodies.length) return { posted: 0, bodies: [] };

  let posted = 0;
  for (const body of bodies) {
    const marked = withAiGeneratedMarker(body);
    try {
      await commentOnIssue(opts.projectId, opts.issueIid, marked);
      posted += 1;
    } catch (err) {
      logger.error("Failed to post agent GitLab comment", {
        jobId: opts.jobId,
        issueIid: opts.issueIid,
        err: String(err),
      });
      throw err;
    }
  }
  logger.info("Posted agent GitLab comments", {
    jobId: opts.jobId,
    issueIid: opts.issueIid,
    posted,
  });
  return { posted, bodies };
}
