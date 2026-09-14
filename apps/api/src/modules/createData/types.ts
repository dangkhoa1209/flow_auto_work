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

export type CreateDataHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CreateDataStepPlan = {
  step_id: string;
  description: string;
  method: CreateDataHttpMethod;
  endpoint: string;
  payload: Record<string, unknown> | null;
  depends_on: string[];
  /** Optional DELETE path template for rollback, e.g. `/api/users/{{id}}` */
  rollback_endpoint?: string | null;
};

export type CreateDataStepResult = {
  step_id: string;
  status: CreateDataStepStatus;
  httpStatus?: number | null;
  response?: unknown;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** Recorded resource id for rollback when present */
  createdId?: string | null;
};

export type CreateDataBatch = {
  id: string;
  batchId: string;
  userId: string;
  baProjectId: string;
  prompt: string;
  environment: CreateDataEnvironment;
  apiBaseUrl: string;
  status: CreateDataBatchStatus;
  steps: CreateDataStepPlan[];
  results: CreateDataStepResult[];
  questions: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
};

export type CreateDataPlanResponse = {
  steps: CreateDataStepPlan[];
  questions: string[];
  notes: string[];
  planner?: "ai" | "heuristic";
  suggestedApiBaseUrl?: string | null;
};
