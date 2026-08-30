/** QC Automation domain types — independent of Dev/GitLab jobs. */

export type QcSelectorContext = {
  primarySelector?: string;
  textContent?: string;
  tagName?: string;
  xpath?: string;
};

export type QcStepAction =
  | "click"
  | "input"
  | "navigate"
  | "upload"
  | "wait"
  | "select";

export type QcFlowStep = {
  action: QcStepAction;
  selectorContext?: QcSelectorContext;
  value?: string;
  url?: string;
  /** Sample file id for upload steps */
  sampleFileId?: string;
  waitMs?: number;
};

export type QcProjectDoc = {
  _id: string;
  ownerUsername: string;
  name: string;
  targetBaseUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type QcFlowDoc = {
  _id: string;
  qcProjectId: string;
  ownerUsername: string;
  name: string;
  steps: QcFlowStep[];
  createdAt: string;
  updatedAt: string;
};

export type QcExecutionPlanItem =
  | { type: "navigate"; url: string }
  | { type: "run_flow"; flowId: string };

export type QcTestCaseDoc = {
  _id: string;
  qcProjectId: string;
  ownerUsername: string;
  name: string;
  loopCount: number;
  executionPlan: QcExecutionPlanItem[];
  createdAt: string;
  updatedAt: string;
};

export type QcSampleFileDoc = {
  _id: string;
  qcProjectId: string;
  ownerUsername: string;
  originalName: string;
  mimeType: string;
  /** Absolute or repo-relative path under uploads/qc/ */
  storagePath: string;
  size: number;
  createdAt: string;
};

export function slugId(prefix: string, name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${slug || "item"}_${rand}`;
}
