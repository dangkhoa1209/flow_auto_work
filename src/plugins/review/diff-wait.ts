import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";

export type DiffApprovalDecision =
  | { action: "approve" }
  | { action: "reject"; message?: string };

type Waiter = {
  resolve: (decision: DiffApprovalDecision) => void;
  reject: (err: Error) => void;
  createdAt: number;
};

const waiters = new Map<string, Waiter>();

export function listPendingDiffApprovals(): Array<{
  jobId: string;
  waitingSec: number;
}> {
  const now = Date.now();
  return [...waiters.entries()].map(([jobId, w]) => ({
    jobId,
    waitingSec: Math.floor((now - w.createdAt) / 1000),
  }));
}

export function isAwaitingDiffApproval(jobId: string): boolean {
  return waiters.has(jobId);
}

/** Block until UI approves / rejects the diff (or timeout). */
export function waitForDiffApproval(jobId: string): Promise<DiffApprovalDecision> {
  const config = getConfig();
  // Reuse clarify timeout window for human review
  const timeoutMs = config.TEAMS_CLARIFY_TIMEOUT_MIN * 60 * 1000;

  return new Promise((resolve, reject) => {
    if (waiters.has(jobId)) {
      waiters.get(jobId)!.reject(new Error("Superseded by a new diff approval wait"));
    }

    const timer = setTimeout(() => {
      waiters.delete(jobId);
      reject(
        new Error(
          `Timed out waiting for diff approval after ${config.TEAMS_CLARIFY_TIMEOUT_MIN} minutes`,
        ),
      );
    }, timeoutMs);

    waiters.set(jobId, {
      createdAt: Date.now(),
      resolve: (decision) => {
        clearTimeout(timer);
        waiters.delete(jobId);
        resolve(decision);
      },
      reject: (err) => {
        clearTimeout(timer);
        waiters.delete(jobId);
        reject(err);
      },
    });

    logger.info("Waiting for diff approval", { jobId });
  });
}

export function submitDiffApproval(
  jobId: string,
  decision: DiffApprovalDecision,
): boolean {
  const waiter = waiters.get(jobId);
  if (!waiter) return false;
  waiter.resolve(decision);
  return true;
}

export function cancelDiffApproval(
  jobId: string,
  reason = "Job force-stopped from UI",
): boolean {
  const waiter = waiters.get(jobId);
  if (!waiter) return false;
  waiter.reject(new Error(reason));
  return true;
}
