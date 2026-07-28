/** Per-project QA staging / login / limits config (Mongo qa_project_configs). */
export type QaProjectConfig = {
  workspaceProjectId: string;
  stagingBaseUrl: string;
  loginPath: string;
  requestBodyKeys: { username: string; password: string };
  tokenJsonPath: string;
  localStorageTokenKey: string;
  maxActions: number;
  actionTimeoutSec: number;
  maxConcurrentSessions: number;
  updatedAt: string;
  createdAt: string;
};

export const DEFAULT_QA_PROJECT_CONFIG: Omit<
  QaProjectConfig,
  "workspaceProjectId" | "stagingBaseUrl" | "updatedAt" | "createdAt"
> = {
  loginPath: "/api/v1/auth/login",
  requestBodyKeys: { username: "username", password: "password" },
  tokenJsonPath: "data.accessToken",
  localStorageTokenKey: "accessToken",
  maxActions: 10,
  actionTimeoutSec: 30,
  maxConcurrentSessions: 1,
};

/** Encrypted test-account preset (Mongo qa_account_presets). */
export type QaAccountPreset = {
  id: string;
  workspaceProjectId: string;
  role: string;
  username: string;
  /** AES-GCM via Flow encryptSecret */
  passwordEnc: string;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type QaAccountPresetPublic = {
  id: string;
  workspaceProjectId: string;
  role: string;
  username: string;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type QaOutcomeKind = "done" | "need_help" | "unknown";

export type QaAgentOutcome = {
  kind: QaOutcomeKind;
  text: string;
  summary?: string;
  helpMessage?: string;
  actionLog?: string[];
  consoleErrors?: Array<{ message: string; stack?: string }>;
  networkFailures?: Array<{
    url: string;
    method: string;
    status: number;
    responseBody?: string;
    initiator?: string;
  }>;
  draftTitle?: string;
  draftMarkdown?: string;
  /** Raw base64 PNG/JPEG without data: URL prefix */
  screenshotBase64?: string;
};
