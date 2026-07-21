import { Agent } from "@cursor/sdk";
import { getConfig } from "../config.js";
import { getReviewDiff } from "../git/diff.js";
import { collectLinkedIssueContext } from "../gitlab/linked-context.js";
import { logger } from "../logger.js";
import type { IssueJob } from "../types.js";

/** One-shot Q&A about a task + current diff (no Teams). */
export async function answerTaskQuestion(opts: {
  issue: IssueJob;
  question: string;
}): Promise<string> {
  const config = getConfig();
  const [diff, linked] = await Promise.all([
    getReviewDiff({ issueIid: opts.issue.issueIid }),
    collectLinkedIssueContext(opts.issue).catch(() => ({
      promptBlock: "",
      linked: [],
      commentExcerpts: [],
    })),
  ]);
  const diffClip = [diff.rangeDiff, diff.staged, diff.unstaged]
    .filter((s) => s.trim())
    .join("\n\n")
    .slice(0, 24000);

  const prompt = `You are helping a developer review / understand work on AiHR v3.

## Issue #${opts.issue.issueIid}
Title: ${opts.issue.title}
URL: ${opts.issue.url}
Labels: ${opts.issue.labels.join(", ") || "(none)"}

## Description
${opts.issue.description || "(empty)"}

${linked.promptBlock || ""}

## Current branch / commits
Branch: ${diff.branch} (base ${diff.base})
Recent commits:
${diff.recentCommits || "(none)"}

## Diff (may be truncated)
\`\`\`diff
${diffClip || "(no diff)"}
\`\`\`

## Question from the human
${opts.question}

Answer clearly in Vietnamese if they wrote Vietnamese. Use linked issues/comments when relevant. Reference files/lines when useful. Do not modify code unless they explicitly ask you to change something — this is a Q&A / review turn.`;

  logger.info("Q&A agent prompt", { issueIid: opts.issue.issueIid });
  const result = await Agent.prompt(prompt, {
    apiKey: config.CURSOR_API_KEY,
    model: { id: config.CURSOR_MODEL },
    local: { cwd: config.AIHR_REPO_PATH },
  });
  if (result.status === "error") {
    throw new Error(`Q&A agent failed: ${result.id}`);
  }
  return (result.result ?? "").trim() || "(no answer)";
}
