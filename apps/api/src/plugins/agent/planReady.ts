/**
 * Parse / format PLAN_READY body for chat + job.planSummary.
 * Mirrors docs ANALYZED/SUMMARY so the PM sees what the agent analyzed.
 */

const PLAN_READY_SECTION = /^(ANALYZED|PLAN)\s*:?\s*$/i;
const PLAN_READY_INLINE = /^(ANALYZED|PLAN)\s*:\s*(.*)$/i;

/** Labeled ANALYZED+PLAN long enough to prefer over unlabeled createPlan. */
const LABELED_PLAN_MIN = 100;

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

/**
 * Agent thinking / status chatter — not the plan the PM should read.
 * Matches English Cursor plan-mode narration and VI status lines.
 */
export function isPlanProcessNarration(text: string): boolean {
  const s = text.trim();
  if (!s) return true;
  if (/^(ANALYZED|PLAN)\s*:/i.test(s)) return false;
  if (/^#{1,3}\s+\S/.test(s)) return false; // real plan headings
  if (/^Đang xác nhận\b/i.test(s) && s.length < 160) return true;
  if (
    /^(Planning work|Starting the plan|I will |I'll |Let me |Looking |Reading |Searching |Querying |Checking |Reviewing |Mapping the|The code map|Documentation points|Code map (search|lệch)|Searching for specific)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (
    /^(Đang (đọc|tìm|kiểm tra|chạy|xác nhận|phân tích|query|map|gọi)|chuyển sang docs)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  // Meta about agent workflow (AGENTS.md / code map) rather than issue solution
  if (
    /\b(AGENTS\.md|code map|graphify|skills and documentation)\b/i.test(s) &&
    /^(Starting|Reading|I will|I'll|Đang đọc|The code map|Planning)\b/i.test(s)
  ) {
    return true;
  }
  return false;
}

/** Drop process/thinking paragraphs from a harvested plan candidate. */
export function stripPlanProcessNarration(text: string): string {
  const t = (text || "").trim();
  if (!t) return "";
  const blocks = t.split(/\n{2,}/);
  const kept = blocks
    .map((b) => b.trim())
    .filter((b) => b && !isPlanProcessNarration(b));
  // Also drop remaining single status lines inside kept blocks
  const lines = kept
    .join("\n\n")
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  const meaningful = lines.filter((l) => {
    const s = l.trim();
    if (!s) return true;
    return !isPlanProcessNarration(s);
  });
  return meaningful
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when most of the text is status/thinking, not a plan body. */
export function isMostlyPlanProcessNarration(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  if (planReadySectionsLen(t) >= LABELED_PLAN_MIN) return false;
  const cleaned = stripPlanProcessNarration(t);
  if (!cleaned) return true;
  if (cleaned.length >= 120 && cleaned.length >= t.length * 0.45) return false;
  return cleaned.length < t.length * 0.45;
}

/** Drop thin status one-liners / empty chrome from a plan chunk (no length cap). */
function trimPlanFluff(text: string): string {
  const t = stripPlanProcessNarration(text);
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

/** Rough signal: Vietnamese diacritics (for preferring VI over English createPlan). */
export function looksVietnamese(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  const marks = t.match(
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/g,
  );
  const n = marks?.length || 0;
  if (n >= 8) return true;
  if (n >= 3 && n / t.length >= 0.015) return true;
  return false;
}

/** Full VI body for job.planSummary (ANALYZED + PLAN; no rigid headings; no truncation). */
export function planReadySummaryText(summaryBody: string): string {
  const analyzed = trimPlanFluff(planReadySection(summaryBody, "ANALYZED"));
  const plan = trimPlanFluff(planReadySection(summaryBody, "PLAN"));
  if (analyzed || plan) {
    return [analyzed, plan].filter(Boolean).join("\n\n");
  }
  const stripped = trimPlanFluff(
    summaryBody.replace(/^(ANALYZED|PLAN)\s*:\s*/gim, ""),
  );
  return stripped || trimPlanFluff(summaryBody) || summaryBody.trim();
}

/** Combined length of ANALYZED + PLAN sections (0 if none). */
export function planReadySectionsLen(summaryBody: string): number {
  const analyzed = planReadySection(summaryBody, "ANALYZED");
  const plan = planReadySection(summaryBody, "PLAN");
  return (analyzed?.length || 0) + (plan?.length || 0);
}

function scorePlanCandidate(raw: string): {
  text: string;
  cleaned: string;
  sections: number;
  scored: number;
  vi: boolean;
  narrationHeavy: boolean;
} {
  const text = raw.trim();
  const stripped = stripPlanProcessNarration(text);
  const narrationHeavy = isMostlyPlanProcessNarration(text);
  // Never rehydrate a narration dump when strip removed everything
  const cleaned = stripped || (narrationHeavy ? "" : text);
  const sections =
    planReadySectionsLen(cleaned) ||
    (!narrationHeavy ? planReadySectionsLen(text) : 0);
  const baseLen = narrationHeavy
    ? cleaned.length
    : Math.max(cleaned.length, sections);
  const scored = sections >= 280 ? sections : Math.max(sections, baseLen);
  return {
    text,
    cleaned,
    sections,
    scored,
    vi: Boolean(cleaned) && looksVietnamese(cleaned),
    narrationHeavy,
  };
}

/**
 * Pick the richest plan source: tagged PLAN_READY body, raw agent text,
 * Process stream, or Cursor `createPlan` tool body.
 * Substantial labeled PLAN_READY (VI) wins over a longer unlabeled createPlan
 * (Cursor often writes createPlan in English). Thin one-liners still lose.
 * Prefer Vietnamese over English; never prefer thinking/status narration dumps.
 */
export function pickPlanReadySource(
  ...candidates: Array<string | undefined | null>
): string {
  let bestLabeled = "";
  let bestLabeledScore = 0;
  let bestAny = "";
  let bestAnyScore = 0;
  let bestVi = "";
  let bestViScore = 0;
  let bestNonNarration = "";
  let bestNonNarrationScore = 0;
  let lastResort = "";
  for (const c of candidates) {
    const t = (c || "").trim();
    if (!t) continue;
    if (!lastResort) lastResort = t;
    const { text, cleaned, sections, scored, vi, narrationHeavy } =
      scorePlanCandidate(t);
    if (sections >= LABELED_PLAN_MIN && sections > bestLabeledScore) {
      bestLabeled = text;
      bestLabeledScore = sections;
    } else if (
      sections >= LABELED_PLAN_MIN &&
      vi &&
      bestLabeled &&
      !looksVietnamese(bestLabeled) &&
      sections >= bestLabeledScore * 0.75
    ) {
      // Prefer shorter Vietnamese labeled body over longer English labeled
      bestLabeled = text;
      bestLabeledScore = sections;
    }
    // Skip empty narration dumps for scoring — never win over a real plan
    if (narrationHeavy && scored <= 0) continue;
    const pickText = narrationHeavy && cleaned ? cleaned : text;
    if (scored > bestAnyScore) {
      bestAny = pickText;
      bestAnyScore = scored;
    }
    if (vi && scored > bestViScore) {
      bestVi = pickText;
      bestViScore = scored;
    }
    if (!narrationHeavy && scored > bestNonNarrationScore) {
      bestNonNarration = text;
      bestNonNarrationScore = scored;
    }
  }
  if (bestLabeled) return bestLabeled;
  // Prefer VI body over a longer English createPlan / stream when VI has real content
  if (bestVi && bestViScore >= 60 && !looksVietnamese(bestAny)) {
    return bestVi;
  }
  if (bestVi && bestViScore >= 80) {
    return bestVi;
  }
  // Prefer a real plan (createPlan / labeled) over thinking dump of similar length
  if (
    bestNonNarration &&
    bestNonNarrationScore >= 40 &&
    isMostlyPlanProcessNarration(bestAny)
  ) {
    return bestNonNarration;
  }
  return bestAny || bestNonNarration || lastResort;
}

/**
 * Chat message after plan phase — full Vietnamese analysis + plan.
 * No word limit; no fixed dual headings; ANALYZED/PLAN labels stripped.
 * Only drop fluff (status one-liners); never truncate substantive body.
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

  const proseRaw = (opts?.prose || "").trim();
  const prose = trimPlanFluff(
    isMostlyPlanProcessNarration(proseRaw)
      ? stripPlanProcessNarration(proseRaw)
      : proseRaw,
  );
  const sectionLen = (analyzed?.length || 0) + (plan?.length || 0);
  const labeledVi = looksVietnamese([analyzed, plan].filter(Boolean).join("\n"));
  const proseVi = looksVietnamese(prose);
  // Only swap in createPlan/stream prose when labeled PLAN_READY is thin.
  // Never replace Vietnamese labeled body with a longer English createPlan.
  // Never swap in thinking/status narration dumps.
  if (
    prose &&
    prose.length > sectionLen + 40 &&
    sectionLen < LABELED_PLAN_MIN &&
    !(labeledVi && !proseVi) &&
    !isMostlyPlanProcessNarration(proseRaw)
  ) {
    const proseAnalyzed = planReadySection(prose, "ANALYZED");
    const prosePlan = planReadySection(prose, "PLAN");
    if (proseAnalyzed || prosePlan) {
      if (planReadySectionsLen(prose) > sectionLen + 40) {
        return formatPlanReadyChatBody(prose);
      }
    }
    // Prefer VI prose over English when labeled body is thin
    if (proseVi || !labeledVi) {
      plan = prose;
    }
  }

  const body = trimPlanFluff([analyzed, plan].filter(Boolean).join("\n\n"));
  const parts: string[] = ["PLAN READY:"];
  if (body && !isMostlyPlanProcessNarration(body)) {
    parts.push("", body);
  } else {
    const fallback =
      planReadySummaryText(summaryBody) ||
      prose ||
      trimPlanFluff(summaryBody);
    if (fallback && !isMostlyPlanProcessNarration(fallback)) {
      parts.push("", fallback);
    } else if (fallback) {
      // Last resort: stripped narration remnant
      const remnant = stripPlanProcessNarration(fallback);
      if (remnant) parts.push("", remnant);
    }
  }
  return parts.join("\n").trim();
}
