/** Per-project Create Data knowledge (rules / side-effects / glossary). */

export type CreateDataRuleType =
  | "unique"
  | "range"
  | "overlap"
  | "required"
  | "custom";

export type CreateDataRuleConfidence = "verified" | "inferred" | "stale";

export type CreateDataRule = {
  rule_id: string;
  collection: string;
  field: string;
  type: CreateDataRuleType;
  condition_summary: string;
  system_message_template: string;
  source_ref: string;
  last_verified_commit: string;
  confidence: CreateDataRuleConfidence;
};

export type CreateDataSideEffect = {
  target_collection: string;
  reason: string;
  required: boolean;
  source_ref: string;
  /** Suggested op for the side-effect step (default insert). */
  target_op?: "insert" | "update" | "delete";
};

export type CreateDataSideEffectEdge = {
  trigger_collection: string;
  trigger_op: "insert" | "update" | "delete";
  required_side_effects: CreateDataSideEffect[];
};

export type CreateDataGlossaryEntry = {
  term: string;
  aliases?: string[];
  collections: string[];
  fields?: string[];
  notes?: string;
};

export type CreateDataKnowledgeStatus =
  | "empty"
  | "ready"
  | "building"
  | "error";

export type CreateDataKnowledgeDoc = {
  id: string;
  baProjectId: string;
  /** Git SHA of project source when knowledge was last built/verified. */
  sourceSha: string | null;
  status: CreateDataKnowledgeStatus;
  rules: CreateDataRule[];
  sideEffectEdges: CreateDataSideEffectEdge[];
  glossary: CreateDataGlossaryEntry[];
  lastError?: string | null;
  builtAt?: string | null;
  updatedAt: string;
  createdAt: string;
};

/** Tunables (defaults match the Generate-optimization prompt). */
export const CREATE_DATA_KNOWLEDGE_DEFAULTS = {
  /** Commits behind HEAD before a verified rule becomes stale. */
  staleAfterCommits: 20,
  /** Pass 1 tool-call budget (LLM pass; heuristic Pass 1 uses 0). */
  pass1ToolBudget: 5,
  /** Pass 2 (deep trace) tool-call budget. */
  pass2ToolBudget: 25,
  /** Max catalog sample docs after Pass 1 scopes collections. */
  targetedSampleMax: 8,
} as const;

export type CreateDataPlanMetrics = {
  pass1Ms: number;
  pass2Ms: number;
  toolCalls: number;
  codeMapCache: "hit" | "miss" | "skip";
  knowledgeStatus: CreateDataKnowledgeStatus | "absent";
  scopedCollections: string[];
};
