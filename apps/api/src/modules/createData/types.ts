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

/** Direct Connect DB write (replaces HTTP seed steps). */
export type CreateDataDbOp = "insert" | "update" | "delete";

export type CreateDataStepPlan = {
  step_id: string;
  description: string;
  op: CreateDataDbOp;
  /** SQL table or Mongo collection */
  collection: string;
  /** Insert document / update fields */
  data: Record<string, unknown> | null;
  /** WHERE / Mongo filter for update|delete */
  filter: Record<string, unknown> | null;
  depends_on: string[];
  /**
   * When true (default for insert), rollback deletes by createdId
   * using filter `{ id| _id: createdId }`.
   */
  rollback?: boolean;
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

export type CreateDataDbSnapshot = {
  dialect: string;
  host: string;
  port: number;
  database: string;
};

export type CreateDataBatch = {
  id: string;
  batchId: string;
  userId: string;
  baProjectId: string;
  prompt: string;
  environment: CreateDataEnvironment;
  /** Legacy HTTP batches only — ignored for DB mode */
  apiBaseUrl?: string;
  /** Snapshot of Connect DB at batch create time */
  dbTarget?: CreateDataDbSnapshot | null;
  mode?: "db" | "http";
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
  /** Connect DB summary for UI */
  suggestedDbTarget?: CreateDataDbSnapshot | null;
};
