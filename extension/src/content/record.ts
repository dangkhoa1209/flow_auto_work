import type { QcStep } from "../shared/types";
import { extractSelectorContext } from "./selector";

let recording = false;
const steps: QcStep[] = [];

function interestingTarget(el: EventTarget | null): Element | null {
  if (!(el instanceof Element)) return null;
  const t = el.closest(
    "a,button,input,textarea,select,[role='button'],[onclick],label",
  );
  return t || el;
}

function onClick(ev: MouseEvent) {
  if (!recording) return;
  const el = interestingTarget(ev.target);
  if (!el) return;
  if ((el as HTMLElement).closest?.("#flow-qc-ignore")) return;
  const step: QcStep = {
    action: "click",
    selectorContext: extractSelectorContext(el),
  };
  steps.push(step);
  void chrome.runtime.sendMessage({ type: "RECORDED_EVENT", step });
}

function onChange(ev: Event) {
  if (!recording) return;
  const el = interestingTarget(ev.target);
  if (!el) return;
  let step: QcStep | null = null;
  if (el instanceof HTMLInputElement && el.type === "file") {
    step = {
      action: "upload",
      selectorContext: extractSelectorContext(el),
      value: el.files?.[0]?.name,
    };
  } else if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement
  ) {
    step = {
      action: "input",
      selectorContext: extractSelectorContext(el),
      value: el.value,
    };
  } else if (el instanceof HTMLSelectElement) {
    step = {
      action: "select",
      selectorContext: extractSelectorContext(el),
      value: el.value,
    };
  }
  if (!step) return;
  steps.push(step);
  void chrome.runtime.sendMessage({ type: "RECORDED_EVENT", step });
}

export function beginRecord(): void {
  if (recording) return;
  recording = true;
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
}

export function endRecord(): void {
  recording = false;
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("change", onChange, true);
}

export function getRecordedSteps(): QcStep[] {
  return [...steps];
}

export function clearRecordedSteps(): void {
  steps.length = 0;
}
