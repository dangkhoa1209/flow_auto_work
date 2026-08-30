import type { QcStep } from "./types";

export type ExtMessage =
  | { type: "PING" }
  | { type: "PONG" }
  | { type: "START_RECORD"; tabId: number }
  | { type: "STOP_RECORD" }
  | { type: "PLAY_PLAN"; tabId: number; steps: QcStep[]; loopTotal?: number }
  | { type: "STOP" }
  | { type: "GET_STATE" }
  | { type: "STATE"; state: unknown }
  | { type: "BEGIN_RECORD" }
  | { type: "END_RECORD" }
  | { type: "EXECUTE_STEP"; step: QcStep }
  | { type: "INJECT_DIALOG_BYPASS" }
  | { type: "STEP_RESULT"; ok: boolean; error?: string }
  | { type: "RECORDED_EVENT"; step: QcStep }
  | { type: "CONTENT_READY" }
  | { type: "GET_RECORDED_STEPS" }
  | { type: "RECORDED_STEPS"; steps: QcStep[] }
  | { type: "CLEAR_RECORDED_STEPS" };

export function sendToTab<T = unknown>(
  tabId: number,
  message: ExtMessage,
): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}
