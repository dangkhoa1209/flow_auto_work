import type { SelectorContext } from "../shared/types";

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function buildPrimarySelector(el: Element): string | undefined {
  const id = el.getAttribute("id");
  if (id) return `#${cssEscape(id)}`;
  const test =
    el.getAttribute("data-test") ||
    el.getAttribute("data-testid") ||
    el.getAttribute("data-cy");
  if (test) return `[data-test="${test}"], [data-testid="${test}"], [data-cy="${test}"]`;
  const name = el.getAttribute("name");
  if (name && el.tagName) {
    return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  }
  return undefined;
}

export function getXPath(el: Element): string {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    let ix = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) ix++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${node.tagName.toLowerCase()}[${ix}]`);
    node = node.parentElement;
  }
  return "/" + parts.join("/");
}

export function extractSelectorContext(el: Element): SelectorContext {
  const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    primarySelector: buildPrimarySelector(el),
    textContent: text || undefined,
    tagName: el.tagName.toLowerCase(),
    xpath: getXPath(el),
  };
}

function xpathAll(expr: string): Element[] {
  const result = document.evaluate(
    expr,
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  const out: Element[] = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    const n = result.snapshotItem(i);
    if (n && n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

export function findByContext(ctx: SelectorContext): Element | null {
  const tag = (ctx.tagName || "*").toLowerCase();
  if (ctx.textContent) {
    const text = ctx.textContent;
    const withText = xpathAll(
      `//${tag}[contains(normalize-space(.), ${JSON.stringify(text)})]`,
    );
    if (withText[0]) return withText[0];
    if (ctx.xpath && ctx.xpath.includes(text)) {
      const byXp = xpathAll(ctx.xpath);
      if (byXp[0]) return byXp[0];
    }
  }
  if (ctx.xpath) {
    const byXp = xpathAll(ctx.xpath);
    if (byXp[0]) return byXp[0];
  }
  if (ctx.primarySelector) {
    try {
      const el = document.querySelector(ctx.primarySelector);
      if (el) return el;
    } catch {
      /* invalid selector */
    }
  }
  return null;
}

export function waitForElement(
  ctx: SelectorContext,
  timeoutMs = 10_000,
): Promise<Element> {
  return new Promise((resolve, reject) => {
    const existing = findByContext(ctx);
    if (existing) {
      resolve(existing);
      return;
    }
    const started = Date.now();
    const obs = new MutationObserver(() => {
      const el = findByContext(ctx);
      if (el) {
        obs.disconnect();
        resolve(el);
      } else if (Date.now() - started > timeoutMs) {
        obs.disconnect();
        reject(new Error("waitForElement timeout"));
      }
    });
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    window.setTimeout(() => {
      obs.disconnect();
      const el = findByContext(ctx);
      if (el) resolve(el);
      else reject(new Error("waitForElement timeout"));
    }, timeoutMs);
  });
}
