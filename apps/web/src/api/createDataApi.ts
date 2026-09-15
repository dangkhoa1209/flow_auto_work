import { api } from "@/api/client";
import { API } from "@/api/endpoints";

export type CreateDataEnvironment = "local" | "staging" | "development";

export type CreateDataStepStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export type CreateDataBatchStatus =
  | "preview"
  | "running"
  | "success"
  | "failed"
  | "partial"
  | "rolled_back";

export type CreateDataDbOp = "insert" | "update" | "delete";

export type CreateDataStepPlan = {
  step_id: string;
  description: string;
  op: CreateDataDbOp;
  collection: string;
  data: Record<string, unknown> | null;
  filter: Record<string, unknown> | null;
  depends_on: string[];
  rollback?: boolean;
};

export type CreateDataStepResult = {
  step_id: string;
  status: CreateDataStepStatus;
  httpStatus?: number | null;
  response?: unknown;
  error?: string | null;
  createdId?: string | null;
};

export type CreateDataDbSnapshot = {
  dialect: string;
  host: string;
  port: number;
  database: string;
};

export type CreateDataBatch = {
  id: string;
  batchId: string;
  baProjectId: string;
  prompt: string;
  environment: CreateDataEnvironment;
  mode?: "db" | "http";
  dbTarget?: CreateDataDbSnapshot | null;
  status: CreateDataBatchStatus;
  steps: CreateDataStepPlan[];
  results: CreateDataStepResult[];
  questions: string[];
  createdAt: string;
  updatedAt: string;
  error?: string | null;
};

export type CreateDataPlan = {
  steps: CreateDataStepPlan[];
  questions: string[];
  notes: string[];
  planner?: "ai" | "heuristic";
  suggestedDbTarget?: CreateDataDbSnapshot | null;
};

/** Planner can run up to ~10 minutes; keep HTTP above the default 120s axios cap. */
export const CREATE_DATA_PLAN_TIMEOUT_MS = 10 * 60 * 1000;

export const createDataApi = {
  plan(opts: {
    prompt: string;
    baProjectId: string;
    environment: CreateDataEnvironment;
    heuristicOnly?: boolean;
  }) {
    return api<{ plan: CreateDataPlan }>(API.ba.createData.plan, {
      method: "POST",
      body: JSON.stringify(opts),
      timeout: CREATE_DATA_PLAN_TIMEOUT_MS,
    });
  },

  stopPlan(baProjectId: string) {
    return api<{ ok: boolean; cancelled: boolean }>(
      API.ba.createData.planStop,
      {
        method: "POST",
        body: JSON.stringify({ baProjectId }),
      },
    );
  },

  listBatches(baProjectId: string) {
    const qs = `?baProjectId=${encodeURIComponent(baProjectId)}`;
    return api<{ batches: CreateDataBatch[] }>(
      `${API.ba.createData.batches}${qs}`,
    );
  },

  createBatch(data: {
    baProjectId: string;
    prompt: string;
    environment: CreateDataEnvironment;
    steps: CreateDataStepPlan[];
    questions?: string[];
  }) {
    return api<{ batch: CreateDataBatch }>(API.ba.createData.batches, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  getBatch(id: string) {
    return api<{ batch: CreateDataBatch }>(API.ba.createData.batch(id));
  },

  execute(id: string) {
    return api<{ batch: CreateDataBatch }>(API.ba.createData.execute(id), {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  rollback(id: string) {
    return api<{ batch: CreateDataBatch }>(API.ba.createData.rollback(id), {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
};
