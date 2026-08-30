/** QC recorder / playback types shared by API + extension. */

export type SelectorContext = {
  primarySelector?: string;
  textContent?: string;
  tagName?: string;
  xpath?: string;
};

export type QcStep = {
  action: "click" | "input" | "navigate" | "upload" | "wait" | "select";
  selectorContext?: SelectorContext;
  value?: string;
  url?: string;
  sampleFileId?: string;
  waitMs?: number;
};

export type ExecutionState = {
  status: "idle" | "playing" | "recording" | "paused_nav";
  tabId?: number;
  steps: QcStep[];
  index: number;
  loopTotal: number;
  loopIndex: number;
  lastError?: string;
};

export const SESSION_KEY = "qcExecutionState";
