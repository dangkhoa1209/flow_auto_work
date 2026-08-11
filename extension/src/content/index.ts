import type { ExtMessage } from "../shared/messages";
import {
  beginRecord,
  clearRecordedSteps,
  endRecord,
  getRecordedSteps,
} from "./record";
import { executeStep, injectDialogBypass, type PlaybackEnv } from "./playback";

let playEnv: PlaybackEnv = {};

chrome.runtime.onMessage.addListener(
  (message: ExtMessage, _sender, sendResponse) => {
    void (async () => {
      try {
        switch (message.type) {
          case "PING":
            sendResponse({ type: "PONG" });
            break;
          case "BEGIN_RECORD":
            beginRecord();
            sendResponse({ ok: true });
            break;
          case "END_RECORD":
            endRecord();
            sendResponse({ ok: true });
            break;
          case "GET_RECORDED_STEPS":
            sendResponse({
              type: "RECORDED_STEPS",
              steps: getRecordedSteps(),
            });
            break;
          case "CLEAR_RECORDED_STEPS":
            clearRecordedSteps();
            sendResponse({ ok: true });
            break;
          case "INJECT_DIALOG_BYPASS":
            injectDialogBypass();
            sendResponse({ ok: true });
            break;
          case "EXECUTE_STEP": {
            injectDialogBypass();
            await executeStep(message.step, playEnv);
            sendResponse({ type: "STEP_RESULT", ok: true });
            break;
          }
          default:
            sendResponse({ ok: false, error: "unknown" });
        }
      } catch (err) {
        sendResponse({
          type: "STEP_RESULT",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  },
);

void chrome.runtime.sendMessage({ type: "CONTENT_READY" });

chrome.storage.session.get(["qcPlayEnv"]).then((data) => {
  if (data.qcPlayEnv && typeof data.qcPlayEnv === "object") {
    playEnv = data.qcPlayEnv as PlaybackEnv;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.qcPlayEnv) {
    playEnv = (changes.qcPlayEnv.newValue as PlaybackEnv) || {};
  }
});
