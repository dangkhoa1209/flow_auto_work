export type IssueJob = {
  projectId: number;
  projectPath: string;
  issueIid: number;
  issueId: number;
  title: string;
  description: string;
  labels: string[];
  url: string;
  action: string;
};

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_clarification"
  | "succeeded"
  | "failed";

export type JobRecord = {
  id: string;
  status: JobStatus;
  issue: IssueJob;
  agentId?: string;
  branch?: string;
  mrUrl?: string;
  clarifyRound: number;
  lastQuestion?: string;
  lastTeamsMessageId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClarificationResult =
  | { kind: "done"; text: string }
  | { kind: "need_clarification"; question: string; text: string }
  | { kind: "error"; message: string; text?: string };
