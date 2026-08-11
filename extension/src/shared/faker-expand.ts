import { faker } from "@faker-js/faker";

const FAKER_RE = /\{\{\s*faker\.([a-zA-Z0-9_.]+)\(\)\s*\}\}/g;
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function callFakerPath(path: string): string {
  const parts = path.split(".");
  let cur: unknown = faker;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return path;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (typeof cur === "function") {
    try {
      return String((cur as () => unknown)());
    } catch {
      return path;
    }
  }
  return String(cur ?? path);
}

/** Expand {{faker.person.fullName()}} and {{var}} in a string. */
export function expandTemplate(
  input: string,
  vars: Record<string, string> = {},
): string {
  let out = input.replace(FAKER_RE, (_m, path: string) => callFakerPath(path));
  out = out.replace(VAR_RE, (_m, name: string) => {
    if (name.startsWith("faker")) return _m;
    return vars[name] ?? "";
  });
  return out;
}

export function expandStepValue<T extends { value?: string; url?: string }>(
  step: T,
  vars: Record<string, string> = {},
): T {
  const next = { ...step };
  if (next.value) next.value = expandTemplate(next.value, vars);
  if (next.url) next.url = expandTemplate(next.url, vars);
  return next;
}
