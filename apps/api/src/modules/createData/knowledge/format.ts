import type { CreateDataKnowledgeDoc } from "./types.js";
import { CREATE_DATA_KNOWLEDGE_DEFAULTS } from "./types.js";
import type { ScopeDetectionResult } from "./scope.js";

function markStaleRules(
  knowledge: CreateDataKnowledgeDoc,
  headSha: string | null,
): CreateDataKnowledgeDoc {
  if (!headSha || !knowledge.sourceSha || knowledge.sourceSha === headSha) {
    return knowledge;
  }
  // Without full git history walk, treat any SHA mismatch as potentially stale.
  // Admin refresh re-verifies. For Generate we only flag inferred/stale for agent.
  return {
    ...knowledge,
    rules: knowledge.rules.map((r) =>
      r.confidence === "verified" && r.last_verified_commit !== headSha
        ? { ...r, confidence: "stale" as const }
        : r,
    ),
  };
}

/** Compact blocks injected into the Seed Planner prompt. */
export function formatKnowledgePromptBlock(opts: {
  knowledge: CreateDataKnowledgeDoc | null;
  scope: ScopeDetectionResult;
  headSha: string | null;
  pass2ToolBudget?: number;
}): string {
  const budget =
    opts.pass2ToolBudget ?? CREATE_DATA_KNOWLEDGE_DEFAULTS.pass2ToolBudget;
  if (!opts.knowledge) {
    return `## Seed knowledge registry
Chưa có rules / side-effect graph / glossary cho project này. Trace tối thiểu trong phạm vi scenario. Tool-call budget Pass 2: **≤ ${budget}**. Nếu thiếu info → questions[], không đoán.`;
  }

  const k = markStaleRules(opts.knowledge, opts.headSha);
  const scopeSet = new Set(
    opts.scope.collections.map((c) => c.toLowerCase()),
  );
  const inScope = (collection: string) =>
    !scopeSet.size || scopeSet.has(collection.toLowerCase());

  const rules = k.rules.filter((r) => inScope(r.collection)).slice(0, 40);
  const edges = k.sideEffectEdges
    .filter((e) => inScope(e.trigger_collection))
    .slice(0, 30);
  const gloss = k.glossary.slice(0, 40);

  const ruleLines = rules.length
    ? rules
        .map(
          (r) =>
            `- [${r.confidence}] ${r.collection}.${r.field} (${r.type}): ${r.condition_summary}` +
            (r.system_message_template
              ? ` | msg: «${r.system_message_template.slice(0, 120)}»`
              : "") +
            (r.source_ref ? ` | src: ${r.source_ref}` : ""),
        )
        .join("\n")
    : "(none in scope)";

  const edgeLines = edges.length
    ? edges
        .map((e) => {
          const req = e.required_side_effects
            .map(
              (s) =>
                `${s.required ? "REQUIRED" : "optional"} → ${s.target_op || "insert"} ${s.target_collection} (${s.reason})`,
            )
            .join("; ");
          return `- ${e.trigger_op} ${e.trigger_collection}: ${req}`;
        })
        .join("\n")
    : "(none in scope)";

  const glossLines = gloss.length
    ? gloss
        .map(
          (g) =>
            `- «${g.term}»${g.aliases?.length ? ` / ${g.aliases.join(", ")}` : ""} → ${g.collections.join(", ")}`,
        )
        .join("\n")
    : "(empty)";

  return `## Seed knowledge registry (per project — dùng trước, đừng re-trace nếu confidence=verified)
Nguồn SHA: ${k.sourceSha || "unknown"} · HEAD: ${opts.headSha || "unknown"} · status: ${k.status}

### Glossary (Pass 1)
${glossLines}

### Business rules
${ruleLines}
Rule stale/inferred: được phép verify nhanh bằng code_map/query trong budget; verified: tin và dùng system_message_template khi hỏi user.

### Side-effect graph (BẮT BUỘC tuân thủ)
${edgeLines}
Khi plan có trigger op/collection ở trên → PHẢI có step cover mọi REQUIRED side-effect. Không bỏ với lý do "async/job".

### Tool-call budget
Pass 2 (deep trace) ≤ **${budget}** tool calls. Chạm budget mà chưa đủ → dừng, trả questions[]. Không mở rộng phạm vi ngoài: ${opts.scope.collections.join(", ") || "(toàn bộ — scope mơ hồ)"}.
`;
}
