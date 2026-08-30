import type { ExtMessage } from "../shared/messages";
import type { ExecutionState, QcStep } from "../shared/types";
import { SESSION_KEY } from "../shared/types";
/** CRX resolves this to the built content-script file for programmatic inject */
import contentScriptUrl from "../content/index.ts?script";

const defaultState = (): ExecutionState => ({
  status: "idle",
  steps: [],
  index: 0,
  loopTotal: 1,
  loopIndex: 0,
});

async function getState(): Promise<ExecutionState> {
  const data = await chrome.storage.session.get(SESSION_KEY);
  return (data[SESSION_KEY] as ExecutionState) || defaultState();
}

async function setState(state: ExecutionState): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: state });
}

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(
    url,
  );
}

async function pingContent(tabId: number): Promise<boolean> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: "PING",
    } satisfies ExtMessage)) as { type?: string } | undefined;
    return res?.type === "PONG";
  } catch {
    return false;
  }
}

/** Ensure content script is alive on tab (inject if missing after reload / SPA). */
async function ensureContentScript(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      "Không ghi được trên trang hệ thống (chrome://…). Hãy mở tab web app (http/https) rồi thử lại.",
    );
  }
  if (await pingContent(tabId)) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [contentScriptUrl],
  });

  // wait briefly for listener registration
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 80));
    if (await pingContent(tabId)) return;
  }
  throw new Error(
    "Content script chưa sẵn sàng — reload tab web app rồi bấm lại.",
  );
}

async function sendToTab<T = unknown>(
  tabId: number,
  message: ExtMessage,
): Promise<T> {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}

async function sendStep(
  tabId: number,
  step: QcStep,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await sendToTab(tabId, { type: "INJECT_DIALOG_BYPASS" });
    const res = (await sendToTab(tabId, {
      type: "EXECUTE_STEP",
      step,
    })) as { ok?: boolean; error?: string; type?: string };
    if (res?.type === "STEP_RESULT") {
      return { ok: Boolean(res.ok), error: res.error };
    }
    return { ok: Boolean(res?.ok), error: res?.error };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function advancePlayback(): Promise<void> {
  const state = await getState();
  if (state.status !== "playing" && state.status !== "paused_nav") return;
  if (state.tabId == null) return;

  if (state.index >= state.steps.length) {
    if (state.loopIndex + 1 < state.loopTotal) {
      state.loopIndex += 1;
      state.index = 0;
      await setState(state);
      await advancePlayback();
      return;
    }
    state.status = "idle";
    await setState(state);
    return;
  }

  const step = state.steps[state.index];
  if (!step) return;

  if (step.action === "navigate" && step.url) {
    state.status = "paused_nav";
    state.index += 1;
    await setState(state);
    await chrome.tabs.update(state.tabId, { url: step.url });
    return;
  }

  const result = await sendStep(state.tabId, step);
  if (!result.ok) {
    state.status = "idle";
    state.lastError = result.error || "step failed";
    await setState(state);
    return;
  }
  state.index += 1;
  state.status = "playing";
  await setState(state);
  setTimeout(() => {
    void advancePlayback();
  }, 120);
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  void (async () => {
    const state = await getState();
    if (state.tabId !== tabId) return;
    if (state.status === "paused_nav" || state.status === "playing") {
      state.status = "playing";
      await setState(state);
      setTimeout(() => void advancePlayback(), 500);
    }
    if (state.status === "recording") {
      try {
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, { type: "BEGIN_RECORD" });
      } catch {
        /* ignore */
      }
    }
  })();
});

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message.type) {
        case "PING":
          sendResponse({ type: "PONG" });
          break;
        case "GET_STATE":
          sendResponse({ type: "STATE", state: await getState() });
          break;
        case "CONTENT_READY":
          sendResponse({ ok: true });
          break;
        case "RECORDED_EVENT": {
          const cur = await getState();
          if (cur.status === "recording") {
            await chrome.storage.session.set({
              qcLastRecorded: message.step,
              qcRecordedAt: Date.now(),
            });
          }
          sendResponse({ ok: true });
          break;
        }
        case "START_RECORD": {
          const state = await getState();
          state.status = "recording";
          state.tabId = message.tabId;
          state.lastError = undefined;
          await setState(state);
          try {
            await ensureContentScript(message.tabId);
            await chrome.tabs.sendMessage(message.tabId, {
              type: "CLEAR_RECORDED_STEPS",
            });
            await chrome.tabs.sendMessage(message.tabId, {
              type: "BEGIN_RECORD",
            });
            sendResponse({ ok: true });
          } catch (err) {
            state.status = "idle";
            state.lastError =
              err instanceof Error ? err.message : "cannot reach content script";
            await setState(state);
            sendResponse({
              ok: false,
              error: state.lastError,
            });
          }
          break;
        }
        case "STOP_RECORD": {
          const state = await getState();
          if (state.tabId != null) {
            try {
              await chrome.tabs.sendMessage(state.tabId, { type: "END_RECORD" });
            } catch {
              /* ignore */
            }
          }
          state.status = "idle";
          await setState(state);
          sendResponse({ ok: true });
          break;
        }
        case "PLAY_PLAN": {
          try {
            await ensureContentScript(message.tabId);
          } catch (err) {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
            break;
          }
          const state: ExecutionState = {
            status: "playing",
            tabId: message.tabId,
            steps: message.steps,
            index: 0,
            loopTotal: Math.max(1, message.loopTotal || 1),
            loopIndex: 0,
          };
          await setState(state);
          await advancePlayback();
          sendResponse({ ok: true });
          break;
        }
        case "STOP": {
          const state = await getState();
          if (state.tabId != null) {
            try {
              await chrome.tabs.sendMessage(state.tabId, { type: "END_RECORD" });
            } catch {
              /* ignore */
            }
          }
          state.status = "idle";
          await setState(state);
          sendResponse({ ok: true });
          break;
        }
        case "GET_RECORDED_STEPS": {
          const state = await getState();
          if (state.tabId == null) {
            sendResponse({ type: "RECORDED_STEPS", steps: [] });
            break;
          }
          try {
            await ensureContentScript(state.tabId);
            const res = await chrome.tabs.sendMessage(state.tabId, {
              type: "GET_RECORDED_STEPS",
            });
            sendResponse(res);
          } catch {
            sendResponse({ type: "RECORDED_STEPS", steps: [] });
          }
          break;
        }
        default:
          sendResponse({ ok: false });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
  return true;
});
