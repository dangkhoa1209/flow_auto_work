import { getConfig } from "../config.js";
import { logger } from "../logger.js";

type Waiter = {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  question: string;
  createdAt: number;
};

const waiters = new Map<string, Waiter>();

export function getPendingClarification(jobId: string): string | null {
  return waiters.get(jobId)?.question ?? null;
}

export function listPendingClarifications(): Array<{
  jobId: string;
  question: string;
  waitingSec: number;
}> {
  const now = Date.now();
  return [...waiters.entries()].map(([jobId, w]) => ({
    jobId,
    question: w.question,
    waitingSec: Math.floor((now - w.createdAt) / 1000),
  }));
}

/** Block until UI posts an answer for this jobId (or timeout). */
export function waitForUiClarification(opts: {
  jobId: string;
  question: string;
}): Promise<string> {
  const config = getConfig();
  const timeoutMs = config.TEAMS_CLARIFY_TIMEOUT_MIN * 60 * 1000;

  return new Promise((resolve, reject) => {
    if (waiters.has(opts.jobId)) {
      waiters.get(opts.jobId)!.reject(
        new Error("Superseded by a new clarification request"),
      );
    }

    const timer = setTimeout(() => {
      waiters.delete(opts.jobId);
      reject(
        new Error(
          `Timed out waiting for UI clarification after ${config.TEAMS_CLARIFY_TIMEOUT_MIN} minutes`,
        ),
      );
    }, timeoutMs);

    waiters.set(opts.jobId, {
      question: opts.question,
      createdAt: Date.now(),
      resolve: (answer) => {
        clearTimeout(timer);
        waiters.delete(opts.jobId);
        resolve(answer);
      },
      reject: (err) => {
        clearTimeout(timer);
        waiters.delete(opts.jobId);
        reject(err);
      },
    });

    logger.info("Waiting for UI clarification", {
      jobId: opts.jobId,
      preview: opts.question.slice(0, 160),
    });
  });
}

export function submitUiClarification(
  jobId: string,
  answer: string,
): boolean {
  const waiter = waiters.get(jobId);
  if (!waiter) return false;
  const text = answer.trim();
  if (!text) return false;
  waiter.resolve(text);
  return true;
}

/** Kill / force-stop: reject waiter so queue can fail the job. */
export function cancelUiClarification(
  jobId: string,
  reason = "Job force-stopped from UI",
): boolean {
  const waiter = waiters.get(jobId);
  if (!waiter) return false;
  waiter.reject(new Error(reason));
  return true;
}
