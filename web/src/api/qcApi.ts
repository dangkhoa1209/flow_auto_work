import { request } from "./http";
import { API } from "./endpoints";

export type QcProject = {
  _id: string;
  ownerUsername: string;
  name: string;
  targetBaseUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type QcSelectorContext = {
  primarySelector?: string;
  textContent?: string;
  tagName?: string;
  xpath?: string;
};

export type QcFlowStep = {
  action: string;
  selectorContext?: QcSelectorContext;
  value?: string;
  url?: string;
  sampleFileId?: string;
  waitMs?: number;
};

export type QcFlow = {
  _id: string;
  qcProjectId: string;
  name: string;
  steps: QcFlowStep[];
  createdAt: string;
  updatedAt: string;
};

export type QcExecutionPlanItem =
  | { type: "navigate"; url: string }
  | { type: "run_flow"; flowId: string };

export type QcTestCase = {
  _id: string;
  qcProjectId: string;
  name: string;
  loopCount: number;
  executionPlan: QcExecutionPlanItem[];
  createdAt: string;
  updatedAt: string;
};

export type QcSampleFile = {
  _id: string;
  qcProjectId: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

const QC_PROJECT_KEY = "flow_qc_project_id";

export function getStoredQcProjectId(): string | null {
  try {
    return localStorage.getItem(QC_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function setStoredQcProjectId(id: string | null): void {
  try {
    if (id) localStorage.setItem(QC_PROJECT_KEY, id);
    else localStorage.removeItem(QC_PROJECT_KEY);
  } catch {
    /* ignore */
  }
}

function qcHeaders(qcProjectId?: string | null): Record<string, string> {
  const id = qcProjectId ?? getStoredQcProjectId();
  return id ? { "X-Qc-Project": id } : {};
}

export const qcApi = {
  setQcRole(enabled: boolean) {
    return request<{ user: { roles?: string[] }; ok: boolean; isQc: boolean }>({
      method: "PUT",
      url: API.me.qcRole,
      data: { enabled },
    });
  },

  listProjects() {
    return request<{ projects: QcProject[] }>({
      method: "GET",
      url: API.qc.projects,
    });
  },

  createProject(data: { name: string; targetBaseUrl: string }) {
    return request<QcProject>({
      method: "POST",
      url: API.qc.projects,
      data,
    });
  },

  updateProject(
    projectId: string,
    data: { name?: string; targetBaseUrl?: string },
  ) {
    return request<QcProject>({
      method: "PATCH",
      url: API.qc.project(projectId),
      data,
    });
  },

  deleteProject(projectId: string) {
    return request<{ ok: true }>({
      method: "DELETE",
      url: API.qc.project(projectId),
    });
  },

  listFlows(qcProjectId?: string) {
    return request<{ flows: QcFlow[] }>({
      method: "GET",
      url: API.qc.flows,
      headers: qcHeaders(qcProjectId),
    });
  },

  createFlow(
    data: { name: string; steps?: QcFlowStep[]; qcProjectId?: string },
    qcProjectId?: string,
  ) {
    return request<QcFlow>({
      method: "POST",
      url: API.qc.flows,
      data,
      headers: qcHeaders(qcProjectId || data.qcProjectId),
    });
  },

  updateFlow(
    flowId: string,
    data: { name?: string; steps?: QcFlowStep[] },
    qcProjectId?: string,
  ) {
    return request<QcFlow>({
      method: "PATCH",
      url: API.qc.flow(flowId),
      data,
      headers: qcHeaders(qcProjectId),
    });
  },

  deleteFlow(flowId: string, qcProjectId?: string) {
    return request<{ ok: true }>({
      method: "DELETE",
      url: API.qc.flow(flowId),
      headers: qcHeaders(qcProjectId),
    });
  },

  listTestCases(qcProjectId?: string) {
    return request<{ testCases: QcTestCase[] }>({
      method: "GET",
      url: API.qc.testCases,
      headers: qcHeaders(qcProjectId),
    });
  },

  createTestCase(
    data: {
      name: string;
      loopCount?: number;
      executionPlan?: QcExecutionPlanItem[];
      qcProjectId?: string;
    },
    qcProjectId?: string,
  ) {
    return request<QcTestCase>({
      method: "POST",
      url: API.qc.testCases,
      data,
      headers: qcHeaders(qcProjectId || data.qcProjectId),
    });
  },

  updateTestCase(
    testCaseId: string,
    data: {
      name?: string;
      loopCount?: number;
      executionPlan?: QcExecutionPlanItem[];
    },
    qcProjectId?: string,
  ) {
    return request<QcTestCase>({
      method: "PATCH",
      url: API.qc.testCase(testCaseId),
      data,
      headers: qcHeaders(qcProjectId),
    });
  },

  deleteTestCase(testCaseId: string, qcProjectId?: string) {
    return request<{ ok: true }>({
      method: "DELETE",
      url: API.qc.testCase(testCaseId),
      headers: qcHeaders(qcProjectId),
    });
  },

  listSampleFiles(qcProjectId?: string) {
    return request<{ files: QcSampleFile[] }>({
      method: "GET",
      url: API.qc.sampleFiles,
      headers: qcHeaders(qcProjectId),
    });
  },

  uploadSampleFile(
    data: {
      originalName: string;
      mimeType: string;
      contentBase64: string;
      qcProjectId?: string;
    },
    qcProjectId?: string,
  ) {
    return request<QcSampleFile>({
      method: "POST",
      url: API.qc.sampleFiles,
      data,
      headers: qcHeaders(qcProjectId || data.qcProjectId),
    });
  },
};
