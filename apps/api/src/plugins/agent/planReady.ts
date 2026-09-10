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

/** Drop thin status one-liners / empty chrome from a plan chunk. */
function trimPlanFluff(text: string): string {
  const t = text.trim();
  if (!t) return "";
  // Single short status line (e.g. "Đang xác nhận…") — keep only if longer body
  const lines = t.split(/\r?\n/).map((l) => l.trimEnd());
  const meaningful = lines.filter((l) => {
    const s = l.trim();
    if (!s) return true; // keep blank separators between real paragraphs
    if (/^(ANALYZED|PLAN)\s*:?\s*$/i.test(s)) return false;
    if (/^Đang xác nhận\b/i.test(s) && s.length < 120) return false;
    return true;
  });
  // Collapse leading/trailing blank lines; keep internal spacing
  return meaningful.join("\n").replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n");
}

/** Short VI summary for job.planSummary (prefers ANALYZED + PLAN, no rigid headings). */
export function planReadySummaryText(summaryBody: string): string {
  const analyzed = trimPlanFluff(planReadySection(summaryBody, "ANALYZED"));
  const plan = trimPlanFluff(planReadySection(summaryBody, "PLAN"));
  if (analyzed || plan) {
    return [analyzed, plan].filter(Boolean).join("\n\n");
  }
  const stripped = trimPlanFluff(
    summaryBody.replace(/^(ANALYZED|PLAN)\s*:\s*/gim, ""),
  );
  return stripped || summaryBody.trim();
}

/** Combined length of ANALYZED + PLAN sections (0 if none). */
export function planReadySectionsLen(summaryBody: string): number {
  const analyzed = planReadySection(summaryBody, "ANALYZED");
  const plan = planReadySection(summaryBody, "PLAN");
  return (analyzed?.length || 0) + (plan?.length || 0);
}

/** Labeled ANALYZED+PLAN long enough to prefer over unlabeled createPlan. */
const LABELED_PLAN_MIN = 100;

/**
 * Pick the richest plan source: tagged PLAN_READY body, raw agent text,
 * Process stream, or Cursor `createPlan` tool body.
 * Substantial labeled PLAN_READY (VI) wins over a longer unlabeled createPlan
 * (Cursor often writes createPlan in English). Thin one-liners still lose.
 */
export function pickPlanReadySource(
  ...candidates: Array<string | undefined | null>
): string {
  let bestLabeled = "";
  let bestLabeledScore = 0;
  let bestAny = "";
  let bestAnyScore = 0;
  for (const c of candidates) {
    const t = (c || "").trim();
    if (!t) continue;
    const sections = planReadySectionsLen(t);
    if (sections >= LABELED_PLAN_MIN && sections > bestLabeledScore) {
      bestLabeled = t;
      bestLabeledScore = sections;
    }
    // Rich labeled sections win on section length; thin labels fall back to full text
    const scored = sections >= 280 ? sections : Math.max(sections, t.length);
    if (scored > bestAnyScore) {
      bestAny = t;
      bestAnyScore = scored;
    }
  }
  return bestLabeled || bestAny;
}

/**
 * Chat message after plan phase — Vietnamese summary of analysis + plan.
 * No fixed dual headings; machine tags ANALYZED/PLAN are stripped for display.
 */
export function formatPlanReadyChatBody(
  summaryBody: string,
  opts?: { prose?: string },
): string {
  const analyzed = trimPlanFluff(planReadySection(summaryBody, "ANALYZED"));
  let plan = trimPlanFluff(
    planReadySection(summaryBody, "PLAN") ||
      summaryBody
        .replace(/^ANALYZED\s*:?\s*[\s\S]*?(?=^PLAN\s*:|$)/im, "")
        .replace(/^PLAN\s*:\s*/im, "")
        .trim(),
  );

  const prose = trimPlanFluff(opts?.prose || "");
  const sectionLen = (analyzed?.length || 0) + (plan?.length || 0);
  // Only swap in createPlan/stream prose when labeled PLAN_READY is thin
  // (otherwise English createPlan would hide a solid Vietnamese PLAN block)
  if (prose && prose.length > sectionLen + 40 && sectionLen < LABELED_PLAN_MIN) {
    const proseAnalyzed = planReadySection(prose, "ANALYZED");
    const prosePlan = planReadySection(prose, "PLAN");
    if (proseAnalyzed || prosePlan) {
      if (planReadySectionsLen(prose) > sectionLen + 40) {
        return formatPlanReadyChatBody(prose);
      }
    }
    plan = prose;
  }

  const body = trimPlanFluff([analyzed, plan].filter(Boolean).join("\n\n"));
  const parts: string[] = ["PLAN READY:"];
  if (body) {
    parts.push("", body);
  } else {
    const fallback =
      planReadySummaryText(summaryBody) ||
      prose.slice(0, 8000) ||
      trimPlanFluff(summaryBody).slice(0, 2000);
    if (fallback) parts.push("", fallback);
  }
  return parts.join("\n").trim();
}
