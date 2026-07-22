import { Agent, CursorAgentError } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { getReviewDiff } from "../git/diff.js";
import { collectLinkedIssueContext } from "../gitlab/linked-context.js";
import { logger } from "../logger.js";
import type { IssueJob } from "../types.js";
import {
  resolveCursorApiKey,
  resolveCursorModel,
  resolveRepoPath,
} from "../workspace/creds.js";
import {
  appendJobProgress,
  appendSdkMessage,
  clearJobProgress,
} from "./progress.js";
import {
  cancelActiveAgentRun,
  trackExternalRun,
  untrackExternalRun,
} from "./run.js";

setMaxListeners(50);

export type QaHistoryTurn = {
  role: string;
  kind?: string;
  body: string;
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

/** Q&A with stream → Progress; advisory only (no long DB/queue execution). */
export async function answerTaskQuestion(opts: {
  issue: IssueJob;
  question: string;
  /** Prior clarify/qa turns (oldest → newest), excluding the current question */
  history?: QaHistoryTurn[];
  jobId?: string;
}): Promise<string> {
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

  const prompt = `You are in **Q&A / review mode** (NOT a full coding Run).

## Hard rules for this turn
1. Answer the human's question using the issue, diff, and codebase.
2. Prefer a clear Vietnamese answer with concrete file/paths/commands they can run.
3. Do **NOT** execute long-running work: no DB mutations that take minutes, no queue workers left running, no seed scripts that hang.
4. You may briefly grep/read files to find how YKKSUB / queue / employee APIs work — then **stop and answer**.
5. If they ask you to *do* the work (connect DB, insert NV, run queue), explain the exact steps from this repo and tell them to use **Run** (or run those commands themselves). Do not try to finish the whole operation in this Q&A turn.
6. Keep the final answer concise (roughly under ~40 lines).

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
  });

  if (jobId) {
    clearJobProgress(jobId);
    appendJobProgress(jobId, "status", `Q&A started · model ${modelId}`);
  }

  const work = async (): Promise<string> => {
    await using agent = await Agent.create({
      apiKey: resolveCursorApiKey(),
      model: { id: modelId },
      local: { cwd: resolveRepoPath() },
    });

    const run = await agent.send(prompt);
    logger.info("Q&A run started", { runId: run.id, agentId: agent.agentId });
    if (jobId) trackExternalRun(jobId, run);

    try {
      let streamed = "";
      try {
        if (
          typeof run.stream === "function" &&
          run.supports?.("stream") !== false
        ) {
          for await (const message of run.stream()) {
            appendSdkMessage(jobId, message);
            if (message.type === "assistant") {
              for (const block of message.message.content) {
                if (block.type === "text") streamed += block.text;
              }
            }
          }
        }
      } catch (err) {
        appendJobProgress(jobId, "status", `Q&A stream error: ${String(err)}`);
        logger.warn("Q&A stream failed; wait()", { err: String(err) });
      }

      const result = await run.wait();
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
      appendJobProgress(jobId, "status", "Q&A finished");
      return text;
    } finally {
      if (jobId) untrackExternalRun(jobId);
    }
  };

  try {
    return await withTimeout(work(), QA_TIMEOUT_MS, "Q&A");
  } catch (err) {
    if (jobId) {
      appendJobProgress(jobId, "status", `Q&A error: ${String(err)}`);
      await cancelActiveAgentRun(jobId).catch(() => undefined);
      untrackExternalRun(jobId);
    }
    if (err instanceof CursorAgentError) {
      throw new Error(`Q&A Cursor error: ${err.message}`);
    }
    throw err;
  }
}
