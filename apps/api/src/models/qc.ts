import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";

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
  sampleFileId?: string;
  waitMs?: number;
};

export type QcExecutionPlanItem =
  | { type: "navigate"; url: string }
  | { type: "run_flow"; flowId: string };

export type QcProjectDoc = {
  _id: string;
  ownerUsername: string;
  name: string;
  targetBaseUrl: string;
  createdAt: string;
  updatedAt: string;
} & SoftDeleteFields;

export type QcFlowDoc = {
  _id: string;
  qcProjectId: string;
  ownerUsername: string;
  name: string;
  steps: QcFlowStep[];
  createdAt: string;
  updatedAt: string;
} & SoftDeleteFields;

export type QcTestCaseDoc = {
  _id: string;
  qcProjectId: string;
  ownerUsername: string;
  name: string;
  loopCount: number;
  executionPlan: QcExecutionPlanItem[];
  createdAt: string;
  updatedAt: string;
} & SoftDeleteFields;

export type QcSampleFileDoc = {
  _id: string;
  qcProjectId: string;
  ownerUsername: string;
  originalName: string;
  mimeType: string;
  storagePath: string;
  size: number;
  createdAt: string;
} & SoftDeleteFields;

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

export const QcProjectModel = createModel<QcProjectDoc>({
  collection: "qc_projects",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  indexes: [{ keys: { ownerUsername: 1 } }],
});

export const QcFlowModel = createModel<QcFlowDoc>({
  collection: "qc_flows",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  indexes: [{ keys: { qcProjectId: 1, updatedAt: -1 } }],
});

export const QcTestCaseModel = createModel<QcTestCaseDoc>({
  collection: "qc_test_cases",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  indexes: [{ keys: { qcProjectId: 1, updatedAt: -1 } }],
});

export const QcSampleFileModel = createModel<QcSampleFileDoc>({
  collection: "qc_sample_files",
  softDelete: true,
  defaultSort: { createdAt: -1 },
  indexes: [{ keys: { qcProjectId: 1, createdAt: -1 } }],
});
