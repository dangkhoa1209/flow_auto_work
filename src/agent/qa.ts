import { Agent, CursorAgentError } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { getReviewDiff } from "../git/diff.js";
import { collectLinkedIssueContext } from "../gitlab/linked-context.js";
import {
  postAgentGitlabComments,
  stripGitlabCommentBlocks,
} from "../gitlab/agent-comment.js";
import { logger } from "../logger.js";
import type { IssueJob } from "../types.js";
import {
  resolveCursorApiKey,
  resolveCursorModel,
  resolveRepoPath,
} from "../workspace/creds.js";
import {
  appendJobProgress,
  appendPromptSending,
  appendSdkMessage,
  clearJobProgress,
  recordTokenUsage,
  type JobTokenSnapshot,
} from "./progress.js";
import {
  beginCancellableJob,
  cancelActiveAgentRun,
} from "./run.js";
import { gitlabCommentInstructions } from "./prompt.js";
import { addChatMessage } from "../db/mongo.js";

setMaxListeners(50);

export type QaHistoryTurn = {
  role: string;
  kind?: string;
  body: string;
};

export type QaResult = {
  answer: string;
  agentId: string;
  usage: JobTokenSnapshot | null;
  resumed: boolean;
};

const QA_TIMEOUT_MS = 3 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${Math.round(ms / 1000)}s — hỏi ngắn hơn, hoặc dùng Run nếu cần agent thực thi DB/queue`,
        ),
      );
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Q&A on the same agent window as the job Run when possible. */
export async function answerTaskQuestion(opts: {
  issue: IssueJob;
  question: string;
  history?: QaHistoryTurn[];
  jobId?: string;
  existingAgentId?: string;
}): Promise<QaResult> {
  const jobId = opts.jobId;
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
    .slice(0, 16000);

  const historyBlock = (opts.history ?? [])
    .filter((t) => t.body?.trim())
    .slice(-24)
    .map((t) => {
      const who = t.role === "user" ? "Human" : "Assistant";
      const kind = t.kind ? ` (${t.kind})` : "";
      return `### ${who}${kind}\n${t.body.trim()}`;
    })
    .join("\n\n");

  const prompt = `You are in **Q&A / review mode** on the same agent window as this job (NOT a full coding Run).

## Hard rules for this turn
1. Answer the human's question using the issue, diff, and codebase.
2. Prefer a clear Vietnamese answer with concrete file/paths/commands they can run.
3. Do **NOT** execute long-running work: no DB mutations that take minutes, no queue workers left running, no seed scripts that hang.
4. You may briefly grep/read files — then **stop and answer**.
5. If they ask you to *do* the work, tell them to click **"Bật Run"** in the Clarify / Q&A panel.
6. Keep the final answer concise (roughly under ~25 lines).
7. Chat UI is narrow: lead with 1–2 sentences + short bullets. No giant Markdown tables; no pasting full QC matrices. Skip machine tags like <<<DONE>>> in the human-readable body.

${gitlabCommentInstructions(opts.issue)}## Issue #${opts.issue.issueIid}
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

${
  historyBlock
    ? `## Prior conversation on this job (use as context)\n${historyBlock}\n`
    : ""
}
## Question from the human
${opts.question}`;

  const modelId = resolveCursorModel();
  logger.info("Q&A agent starting", {
    issueIid: opts.issue.issueIid,
    historyTurns: opts.history?.length ?? 0,
    model: modelId,
    jobId,
    existingAgentId: opts.existingAgentId || null,
  });

  if (jobId) {
    clearJobProgress(jobId);
    appendJobProgress(jobId, "status", `Q&A started · model ${modelId}`);
  }

  const work = async (): Promise<QaResult> => {
    let resumed = false;
    let agent: Awaited<ReturnType<typeof Agent.create>>;
    const session = beginCancellableJob(jobId);
    try {
      session.check();
      const existing = opts.existingAgentId?.trim();
      if (existing) {
        try {
          agent = await Agent.resume(existing, {
            apiKey: resolveCursorApiKey(),
            model: { id: modelId },
            local: { cwd: resolveRepoPath() },
          });
          resumed = true;
        } catch (err) {
          logger.warn("Q&A resume failed — new window", { err: String(err) });
          session.check();
          agent = await Agent.create({
            apiKey: resolveCursorApiKey(),
            model: { id: modelId },
            local: { cwd: resolveRepoPath() },
          });
        }
      } else {
        agent = await Agent.create({
          apiKey: resolveCursorApiKey(),
          model: { id: modelId },
          local: { cwd: resolveRepoPath() },
        });
      }

      session.check();
      await using disposed = agent;
      if (jobId) {
        appendJobProgress(
          jobId,
          "status",
          resumed
            ? `Q&A on agent window ${disposed.agentId}`
            : `Q&A new agent window ${disposed.agentId}`,
        );
        appendPromptSending(jobId, prompt);
      }

      session.check();
      const run = await disposed.send(prompt);
      logger.info("Q&A run started", {
        runId: run.id,
        agentId: disposed.agentId,
        resumed,
      });
      session.attach(run);

      try {
        let streamed = "";
        let lastTurnInput = 0;
        try {
          if (
            typeof run.stream === "function" &&
            run.supports?.("stream") !== false
          ) {
            for await (const message of run.stream()) {
              session.check();
              appendSdkMessage(jobId, message);
              if (message.type === "assistant") {
                for (const block of message.message.content) {
                  if (block.type === "text") streamed += block.text;
                }
              }
              const raw = message as {
                type?: string;
                usage?: { inputTokens?: number };
              };
              if (raw.type === "usage" && raw.usage?.inputTokens) {
                lastTurnInput = raw.usage.inputTokens;
              }
            }
          }
        } catch (err) {
          session.check();
          appendJobProgress(jobId, "status", `Q&A stream error: ${String(err)}`);
          logger.warn("Q&A stream failed; wait()", { err: String(err) });
        }

        const result = await run.wait();
        session.check();
        if (result.status === "cancelled") {
          throw new Error("Q&A cancelled (force stop)");
        }
        if (result.status === "error") {
          const detail = result as {
            id: string;
            result?: string;
            errorCode?: string;
          };
          throw new Error(
            `Q&A failed (${detail.id})${detail.errorCode ? ` · ${detail.errorCode}` : ""}${detail.result ? `: ${detail.result.slice(0, 300)}` : ""}`,
          );
        }
        const text = (result.result ?? streamed).trim() || "(no answer)";
        const sdkU = (result as { usage?: Parameters<typeof recordTokenUsage>[1] })
          .usage;
        const hasSdk =
          Boolean(sdkU) &&
          (Number(sdkU?.inputTokens) > 0 || Number(sdkU?.totalTokens) > 0);
        const inEst = Math.max(1, Math.ceil(prompt.length / 4));
        const outEst = Math.max(0, Math.ceil(text.length / 4));
        const usage = jobId
          ? recordTokenUsage(
              jobId,
              hasSdk
                ? sdkU
                : {
                    inputTokens: inEst,
                    outputTokens: outEst,
                    totalTokens: inEst + outEst,
                  },
              { lastTurnInput: lastTurnInput || (hasSdk ? undefined : inEst) },
            )
          : null;
        appendJobProgress(jobId, "status", "Q&A finished");

        // Post any <<<GITLAB_COMMENT>>> blocks Flow-side
        let commentsPosted = 0;
        try {
          const posted = await postAgentGitlabComments({
            projectId: opts.issue.projectId,
            issueIid: opts.issue.issueIid,
            agentText: text,
            jobId,
          });
          commentsPosted = posted.posted;
          if (commentsPosted > 0 && jobId) {
            await addChatMessage({
              jobId,
              issueIid: opts.issue.issueIid,
              role: "system",
              kind: "note",
              body: `Đã đăng ${commentsPosted} comment lên GitLab #${opts.issue.issueIid} (AI-Generated).`,
            });
          }
        } catch (err) {
          logger.warn("Q&A GitLab comment post failed", { err: String(err) });
        }

        return {
          answer: stripGitlabCommentBlocks(text) || text,
          agentId: disposed.agentId,
          usage,
          resumed,
        };
      } finally {
        /* session.end in outer finally */
      }
    } finally {
      session.end();
    }
  };

  try {
    return await withTimeout(work(), QA_TIMEOUT_MS, "Q&A");
  } catch (err) {
    if (jobId) {
      appendJobProgress(jobId, "status", `Q&A error: ${String(err)}`);
      await cancelActiveAgentRun(jobId).catch(() => undefined);
    }
    if (err instanceof CursorAgentError) {
      throw new Error(`Q&A Cursor error: ${err.message}`);
    }
    throw err;
  }
}
