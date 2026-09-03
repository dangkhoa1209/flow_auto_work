/** Job lifecycle statuses shared by API + web. */
export type JobStatus =
  /** Job shell — issue linked, Dev Notes in progress, not yet (re)run */
  | "draft"
  | "queued"
  | "running"
  | "awaiting_clarification"
  /** Docs phase done — awaiting PM analysis approval in UI */
  | "awaiting_docs_approval"
  /** Plan-first phase done — awaiting PM approval before coding */
  | "awaiting_plan_approval"
  /** @deprecated legacy — migrated to succeeded on boot (push/MR gate removed) */
  | "awaiting_diff_approval"
  /** Need Google OAuth to read Sheets links in the task */
  | "awaiting_google_auth"
  /** Need project Figma PAT (Settings → Integrations) to read opted-in links */
  | "awaiting_figma_auth"
  /** Code done (GitLab API commit) — awaiting manual assign / labels */
  | "awaiting_handoff"
  | "succeeded"
  | "failed";

export function isJobBusy(status: JobStatus): boolean {
  // awaiting_* idle states — user acts in UI (not a blocked waiter)
  return status === "queued" || status === "running";
}
