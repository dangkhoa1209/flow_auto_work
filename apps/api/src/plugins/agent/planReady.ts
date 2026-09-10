/**
 * Parse / format PLAN_READY body for chat + job.planSummary.
 * Mirrors docs ANALYZED/SUMMARY so the PM sees what the agent analyzed.
 */

const PLAN_READY_SECTION = /^(ANALYZED|PLAN)\s*:?\s*$/i;
const PLAN_READY_INLINE = /^(ANALYZED|PLAN)\s*:\s*(.*)$/i;

/** Extract one labeled section from a PLAN_READY body. */
export function planReadySection(
  summaryBody: string,
  field: "ANALYZED" | "PLAN",
): string {
  const lines = summaryBody.split(/\r?\n/);
  const want = field.toUpperCase();
  const out: string[] = [];
  let inField = false;
  for (const raw of lines) {
    const inline = raw.match(PLAN_READY_INLINE);
    if (inline) {
      const name = inline[1].toUpperCase();
      if (name === want) {
        inField = true;
        if (inline[2]?.trim()) out.push(inline[2].trim());
        continue;
      }
      if (inField) break;
      continue;
    }
    if (PLAN_READY_SECTION.test(raw.trim())) {
      const name = raw
        .trim()
        .replace(/\s*:?\s*$/, "")
        .toUpperCase();
      if (name === want) {
        inField = true;
        continue;
      }
      if (inField) break;
      continue;
    }
    if (inField) out.push(raw);
  }
  return out.join("\n").trim();
}

/** Short VI summary for job.planSummary (prefers ANALYZED + PLAN). */
export function planReadySummaryText(summaryBody: string): string {
  const analyzed = planReadySection(summaryBody, "ANALYZED");
  const plan = planReadySection(summaryBody, "PLAN");
  if (analyzed || plan) {
    return [analyzed && `Đã phân tích:\n${analyzed}`, plan && `Kế hoạch:\n${plan}`]
      .filter(Boolean)
      .join("\n\n");
  }
  const stripped = summaryBody
    .replace(/^(ANALYZED|PLAN)\s*:\s*/gim, "")
    .trim();
  return stripped || summaryBody.trim();
}

/** Combined length of ANALYZED + PLAN sections (0 if none). */
export function planReadySectionsLen(summaryBody: string): number {
  const analyzed = planReadySection(summaryBody, "ANALYZED");
  const plan = planReadySection(summaryBody, "PLAN");
  return (analyzed?.length || 0) + (plan?.length || 0);
}

/**
 * Pick the richest plan source: tagged PLAN_READY body, raw agent text, or
 * Process stream (thinking/assistant) — so Chat is not stuck on a one-liner
 * while the real plan only lived in clipped Process logs.
 */
export function pickPlanReadySource(
  ...candidates: Array<string | undefined | null>
): string {
  let best = "";
  for (const c of candidates) {
    const t = (c || "").trim();
    if (!t) continue;
    const scored = planReadySectionsLen(t) || t.length;
    const bestScored = planReadySectionsLen(best) || best.length;
    if (scored > bestScored) best = t;
  }
  return best;
}

/** Chat message after plan phase — analysis + plan for the pair. */
export function formatPlanReadyChatBody(
  summaryBody: string,
  opts?: { prose?: string },
): string {
  const analyzed = planReadySection(summaryBody, "ANALYZED");
  let plan =
    planReadySection(summaryBody, "PLAN") ||
    summaryBody
      .replace(/^ANALYZED\s*:?\s*[\s\S]*?(?=^PLAN\s*:|$)/im, "")
      .replace(/^PLAN\s*:\s*/im, "")
      .trim();

  const prose = (opts?.prose || "").trim();
  const sectionLen = (analyzed?.length || 0) + (plan?.length || 0);
  // Thin PLAN_READY marker but long stream/prose → prefer prose under Kế hoạch
  if (prose && prose.length > sectionLen + 40 && sectionLen < 280) {
    const proseAnalyzed = planReadySection(prose, "ANALYZED");
    const prosePlan = planReadySection(prose, "PLAN");
    if (proseAnalyzed || prosePlan) {
      return formatPlanReadyChatBody(prose);
    }
    plan = prose;
  }

  const parts: string[] = ["PLAN READY:"];
  if (analyzed) {
    parts.push("", "### Đã phân tích", analyzed);
  }
  if (plan) {
    parts.push("", "### Kế hoạch", plan);
  }
  if (!analyzed && !plan) {
    const fallback =
      planReadySummaryText(summaryBody) ||
      prose.slice(0, 8000) ||
      summaryBody.slice(0, 2000);
    if (fallback) parts.push("", fallback);
  }
  return parts.join("\n").trim();
}
