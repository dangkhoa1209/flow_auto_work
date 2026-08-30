import type { QcStep } from "../shared/types";
import { waitForElement } from "./selector";

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function assignFile(el: HTMLInputElement, file: File) {
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fetchSampleAsFile(opts: {
  apiBase: string;
  accessToken: string;
  qcProjectId: string;
  sampleFileId: string;
  fileName?: string;
}): Promise<File> {
  const res = await fetch(
    `${opts.apiBase.replace(/\/$/, "")}/api/qc/sample-files/${encodeURIComponent(opts.sampleFileId)}`,
    {
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "X-Qc-Project": opts.qcProjectId,
      },
    },
  );
  if (!res.ok) throw new Error(`sample file download ${res.status}`);
  const blob = await res.blob();
  const name =
    opts.fileName ||
    res.headers.get("content-disposition")?.match(/filename="?([^"]+)"?/)?.[1] ||
    "upload.bin";
  return new File([blob], name, {
    type: blob.type || "application/octet-stream",
  });
}

export type PlaybackEnv = {
  apiBase?: string;
  accessToken?: string;
  qcProjectId?: string;
};

export async function executeStep(
  step: QcStep,
  env: PlaybackEnv = {},
): Promise<void> {
  if (step.action === "wait") {
    await new Promise((r) => setTimeout(r, step.waitMs || 500));
    return;
  }
  if (step.action === "navigate") {
    if (!step.url) throw new Error("navigate missing url");
    window.location.href = step.url;
    return;
  }
  if (!step.selectorContext) throw new Error("step missing selectorContext");
  const el = await waitForElement(step.selectorContext, 10_000);

  if (step.action === "click") {
    (el as HTMLElement).click();
    return;
  }
  if (step.action === "input") {
    if (
      !(el instanceof HTMLInputElement) &&
      !(el instanceof HTMLTextAreaElement)
    ) {
      throw new Error("input target is not an input/textarea");
    }
    setNativeValue(el, step.value ?? "");
    return;
  }
  if (step.action === "select") {
    if (!(el instanceof HTMLSelectElement)) {
      throw new Error("select target is not a select");
    }
    el.value = step.value ?? "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (step.action === "upload") {
    if (!(el instanceof HTMLInputElement) || el.type !== "file") {
      throw new Error("upload target is not input[type=file]");
    }
    if (!step.sampleFileId) {
      throw new Error("upload step needs sampleFileId");
    }
    if (!env.apiBase || !env.accessToken || !env.qcProjectId) {
      throw new Error("upload needs apiBase, accessToken, qcProjectId");
    }
    const file = await fetchSampleAsFile({
      apiBase: env.apiBase,
      accessToken: env.accessToken,
      qcProjectId: env.qcProjectId,
      sampleFileId: step.sampleFileId,
      fileName: step.value,
    });
    await assignFile(el, file);
    return;
  }
  throw new Error(`unsupported action ${step.action}`);
}

export function injectDialogBypass(): void {
  const id = "flow-qc-dialog-bypass";
  if (document.getElementById(id)) return;
  const s = document.createElement("script");
  s.id = id;
  s.textContent = `
    window.confirm = function() { return true; };
    window.alert = function() { return true; };
    window.prompt = function(msg, def) { return def || ''; };
  `;
  (document.documentElement || document.head).appendChild(s);
  s.remove();
}
