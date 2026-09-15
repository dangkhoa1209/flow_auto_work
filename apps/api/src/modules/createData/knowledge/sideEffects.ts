import type { CreateDataPlanResponse, CreateDataStepPlan } from "../types.js";
import type { CreateDataSideEffectEdge } from "./types.js";

export type SideEffectGap = {
  trigger_collection: string;
  trigger_op: string;
  target_collection: string;
  reason: string;
  source_ref: string;
};

/**
 * Server-side check: every required side-effect edge must be covered by a step
 * in the plan (same batch) when the trigger collection/op is present.
 */
export function findMissingSideEffects(
  steps: CreateDataStepPlan[],
  edges: CreateDataSideEffectEdge[],
): SideEffectGap[] {
  if (!edges.length || !steps.length) return [];

  const present = new Set(
    steps.map((s) => `${s.op}::${s.collection.toLowerCase()}`),
  );
  const collections = new Set(
    steps.map((s) => s.collection.toLowerCase()),
  );

  const gaps: SideEffectGap[] = [];
  for (const edge of edges) {
    const triggerKey = `${edge.trigger_op}::${edge.trigger_collection.toLowerCase()}`;
    if (!present.has(triggerKey)) continue;
    for (const se of edge.required_side_effects) {
      if (!se.required) continue;
      const targetOp = se.target_op || "insert";
      const targetKey = `${targetOp}::${se.target_collection.toLowerCase()}`;
      // Accept either exact op+collection or any step on that collection.
      if (
        present.has(targetKey) ||
        collections.has(se.target_collection.toLowerCase())
      ) {
        continue;
      }
      gaps.push({
        trigger_collection: edge.trigger_collection,
        trigger_op: edge.trigger_op,
        target_collection: se.target_collection,
        reason: se.reason,
        source_ref: se.source_ref,
      });
    }
  }
  return gaps;
}

/**
 * Enrich plan with questions/notes when required side-effects are missing.
 * Does not invent steps — asks the planner/user to fix (safer than auto-insert).
 */
export function applySideEffectValidation(
  plan: CreateDataPlanResponse,
  edges: CreateDataSideEffectEdge[],
): CreateDataPlanResponse & { sideEffectGaps: SideEffectGap[] } {
  const gaps = findMissingSideEffects(plan.steps || [], edges);
  if (!gaps.length) return { ...plan, sideEffectGaps: [] };

  const questions = [...(plan.questions || [])];
  const notes = [...(plan.notes || [])];

  for (const g of gaps) {
    const msg = `Plan is incomplete: ${g.trigger_op} on "${g.trigger_collection}" requires a related "${g.target_collection}" step (${g.reason}). Add that step or confirm it is not needed.`;
    if (!questions.some((q) => q.includes(g.target_collection))) {
      questions.push(msg);
    }
    notes.push(
      `Side-effect gap: ${g.trigger_op} ${g.trigger_collection} → ${g.target_collection} (${g.source_ref || "graph"})`,
    );
  }

  // Block execute path: clear steps when required side-effects missing so UI
  // treats this like a validation/clarification turn.
  return {
    ...plan,
    steps: [],
    questions,
    notes,
    sideEffectGaps: gaps,
  };
}
