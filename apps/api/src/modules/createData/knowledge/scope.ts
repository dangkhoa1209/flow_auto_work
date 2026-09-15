import type { CreateDataKnowledgeDoc, CreateDataGlossaryEntry } from "./types.js";

export type ScopeDetectionResult = {
  collections: string[];
  glossaryHits: string[];
  ambiguous: boolean;
  reason: string;
};

const WORD_RE = /[a-zA-ZÀ-ỹ_]{3,}/g;

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * Pass 1 (no LLM): map scenario + issue text to collections via glossary and
 * known rules/edges. Returns ambiguous when nothing matched.
 */
export function detectCreateDataScope(opts: {
  texts: string[];
  knowledge: CreateDataKnowledgeDoc | null;
}): ScopeDetectionResult {
  const combined = opts.texts.filter(Boolean).join("\n");
  const text = norm(combined);
  const tokens = new Set(
    (combined.toLowerCase().match(WORD_RE) || []).map((t) => norm(t)),
  );

  const collections = new Set<string>();
  const glossaryHits: string[] = [];

  const glossary: CreateDataGlossaryEntry[] = opts.knowledge?.glossary || [];
  for (const g of glossary) {
    const terms = [g.term, ...(g.aliases || [])].map(norm).filter(Boolean);
    const hit = terms.some(
      (t) => t.length >= 3 && (text.includes(t) || tokens.has(t)),
    );
    if (!hit) continue;
    glossaryHits.push(g.term);
    for (const c of g.collections || []) {
      if (c.trim()) collections.add(c.trim());
    }
  }

  // Also match collection names that appear literally in the prompt.
  for (const edge of opts.knowledge?.sideEffectEdges || []) {
    const names = [
      edge.trigger_collection,
      ...edge.required_side_effects.map((s) => s.target_collection),
    ];
    for (const name of names) {
      const n = norm(name);
      if (n && (text.includes(n) || text.includes(n.replace(/s$/, "")))) {
        collections.add(name);
      }
    }
  }
  for (const rule of opts.knowledge?.rules || []) {
    const n = norm(rule.collection);
    if (n && text.includes(n)) collections.add(rule.collection);
  }

  // Common Vietnamese / English domain hints when glossary empty.
  const FALLBACK: Array<[RegExp, string[]]> = [
    [/\b(nhan vien|nhân viên|staff|employee|nv)\b/i, ["staffs", "staff"]],
    [/\b(phep|phép|leave|nghi phep|nghỉ phép)\b/i, ["staff_leaves", "time_leave"]],
    [/\b(don hang|đơn hàng|order)\b/i, ["orders"]],
    [/\b(user|nguoi dung|người dùng)\b/i, ["users"]],
  ];
  if (!collections.size) {
    for (const [re, cols] of FALLBACK) {
      if (re.test(combined)) {
        for (const c of cols) collections.add(c);
      }
    }
  }

  const list = [...collections];
  if (!list.length) {
    return {
      collections: [],
      glossaryHits,
      ambiguous: true,
      reason:
        "Could not determine which collections this scenario touches — add more detail or refresh seed knowledge (glossary).",
    };
  }
  return {
    collections: list,
    glossaryHits,
    ambiguous: false,
    reason: `Scoped to ${list.join(", ")}`,
  };
}
