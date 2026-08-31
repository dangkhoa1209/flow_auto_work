/** Mirror API normalizeUserRoles — empty roles → dev; admin keeps explicit role. */
export function effectiveRoles(roles?: string[] | null): string[] {
  const out: string[] = [];
  for (const r of roles || []) {
    if (
      r === "dev" ||
      r === "admin" ||
      r === "qc" ||
      r === "ba" ||
      r === "pd" ||
      r === "devops"
    ) {
      if (!out.includes(r)) out.push(r);
    }
  }
  if (out.length === 0) return ["dev"];
  return out;
}

export function hasAnyRole(
  roles: string[] | null | undefined,
  ...need: string[]
): boolean {
  const r = effectiveRoles(roles);
  return need.some((n) => r.includes(n));
}
