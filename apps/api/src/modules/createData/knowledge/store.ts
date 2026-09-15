import { randomUUID } from "node:crypto";
import { CreateDataKnowledgeModel } from "../../../models/createDataKnowledge.js";
import type {
  CreateDataGlossaryEntry,
  CreateDataKnowledgeDoc,
  CreateDataRule,
  CreateDataSideEffectEdge,
} from "./types.js";

export async function ensureCreateDataKnowledgeIndexes(): Promise<void> {
  await CreateDataKnowledgeModel.ensureIndexes();
}

export async function getCreateDataKnowledge(
  baProjectId: string,
): Promise<CreateDataKnowledgeDoc | null> {
  const row = await CreateDataKnowledgeModel.findOne({ baProjectId } as never);
  return (row as CreateDataKnowledgeDoc | null) ?? null;
}

export async function upsertCreateDataKnowledge(
  baProjectId: string,
  patch: Partial<
    Pick<
      CreateDataKnowledgeDoc,
      | "rules"
      | "sideEffectEdges"
      | "glossary"
      | "sourceSha"
      | "status"
      | "lastError"
      | "builtAt"
    >
  >,
): Promise<CreateDataKnowledgeDoc> {
  const now = new Date().toISOString();
  const existing = await getCreateDataKnowledge(baProjectId);
  if (!existing) {
    const doc: CreateDataKnowledgeDoc = {
      id: randomUUID(),
      baProjectId,
      sourceSha: patch.sourceSha ?? null,
      status: patch.status ?? "empty",
      rules: patch.rules ?? [],
      sideEffectEdges: patch.sideEffectEdges ?? [],
      glossary: patch.glossary ?? [],
      lastError: patch.lastError ?? null,
      builtAt: patch.builtAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await CreateDataKnowledgeModel.insert(doc as never);
    return doc;
  }
  const next: CreateDataKnowledgeDoc = {
    ...existing,
    ...patch,
    rules: patch.rules ?? existing.rules,
    sideEffectEdges: patch.sideEffectEdges ?? existing.sideEffectEdges,
    glossary: patch.glossary ?? existing.glossary,
    updatedAt: now,
  };
  await CreateDataKnowledgeModel.updateById(existing.id, next as never);
  return next;
}

/** Merge inferred rules/edges/glossary without wiping admin-verified entries. */
export async function mergeCreateDataKnowledge(
  baProjectId: string,
  incoming: {
    rules?: CreateDataRule[];
    sideEffectEdges?: CreateDataSideEffectEdge[];
    glossary?: CreateDataGlossaryEntry[];
    sourceSha?: string | null;
  },
): Promise<CreateDataKnowledgeDoc> {
  const existing = await getCreateDataKnowledge(baProjectId);
  const rulesById = new Map(
    (existing?.rules || []).map((r) => [r.rule_id, r] as const),
  );
  for (const r of incoming.rules || []) {
    const prev = rulesById.get(r.rule_id);
    if (prev?.confidence === "verified" && r.confidence !== "verified") {
      continue;
    }
    rulesById.set(r.rule_id, r);
  }

  const edgeKey = (e: CreateDataSideEffectEdge) =>
    `${e.trigger_collection}::${e.trigger_op}`;
  const edgesByKey = new Map(
    (existing?.sideEffectEdges || []).map((e) => [edgeKey(e), e] as const),
  );
  for (const e of incoming.sideEffectEdges || []) {
    const prev = edgesByKey.get(edgeKey(e));
    if (!prev) {
      edgesByKey.set(edgeKey(e), e);
      continue;
    }
    const seen = new Set(
      prev.required_side_effects.map((s) => s.target_collection),
    );
    const merged = [...prev.required_side_effects];
    for (const s of e.required_side_effects) {
      if (!seen.has(s.target_collection)) {
        merged.push(s);
        seen.add(s.target_collection);
      }
    }
    edgesByKey.set(edgeKey(e), { ...prev, required_side_effects: merged });
  }

  const glossByTerm = new Map(
    (existing?.glossary || []).map(
      (g) => [g.term.toLowerCase(), g] as const,
    ),
  );
  for (const g of incoming.glossary || []) {
    const key = g.term.toLowerCase();
    const prev = glossByTerm.get(key);
    if (!prev) {
      glossByTerm.set(key, g);
      continue;
    }
    glossByTerm.set(key, {
      ...prev,
      aliases: [...new Set([...(prev.aliases || []), ...(g.aliases || [])])],
      collections: [
        ...new Set([...(prev.collections || []), ...(g.collections || [])]),
      ],
      fields: [...new Set([...(prev.fields || []), ...(g.fields || [])])],
      notes: g.notes || prev.notes,
    });
  }

  return upsertCreateDataKnowledge(baProjectId, {
    rules: [...rulesById.values()],
    sideEffectEdges: [...edgesByKey.values()],
    glossary: [...glossByTerm.values()],
    sourceSha: incoming.sourceSha ?? existing?.sourceSha ?? null,
    status:
      rulesById.size || edgesByKey.size || glossByTerm.size
        ? "ready"
        : "empty",
    builtAt: new Date().toISOString(),
    lastError: null,
  });
}
