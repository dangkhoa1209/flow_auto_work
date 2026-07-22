/** Human-readable job/task status for UI */
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  queued: "Queued",
  running: "Running",
  awaiting_clarification: "Awaiting clarification",
  awaiting_docs_approval: "Awaiting docs approval",
  awaiting_diff_approval: "Awaiting diff approval",
  awaiting_handoff: "Awaiting handoff",
  succeeded: "Done",
  failed: "Failed",
};

/** Statuses that can be set manually from the Jobs list */
export const MANUAL_JOB_STATUSES = [
  "draft",
  "awaiting_handoff",
  "succeeded",
  "failed",
] as const;

export type ManualJobStatus = (typeof MANUAL_JOB_STATUSES)[number];

/** succeeded → Done; others Title case / spaced */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const mapped = STATUS_LABELS[status];
  if (mapped) return mapped;
  return status
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
