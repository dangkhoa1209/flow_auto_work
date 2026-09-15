import { randomUUID } from "node:crypto";
import { mergeCreateDataKnowledge } from "./store.js";
import type {
  CreateDataRule,
  CreateDataSideEffectEdge,
  CreateDataGlossaryEntry,
} from "./types.js";

/**
 * Custom tool for the Seed Planner: propose new knowledge entries to the
 * WorkBench registry (not the customer seed DB). Runs server-side.
 */
export function buildProposeSeedKnowledgeTool(baProjectId: string): Record<
  string,
  {
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
  }
> {
  return {
    propose_seed_knowledge: {
      description:
        "Propose a new business rule, side-effect edge, or glossary mapping for this project's Create Data knowledge registry (WorkBench). " +
        "Use when you discover something not already in the Seed knowledge registry. Does NOT write to the customer seed DB.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "rule | side_effect | glossary",
          },
          payload: {
            type: "string",
            description: "JSON object for the chosen kind",
          },
        },
        required: ["kind", "payload"],
      },
      async execute(args) {
        const kind = String(args?.kind || "").trim();
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(String(args?.payload || "{}")) as Record<
            string,
            unknown
          >;
        } catch {
          return "Invalid payload JSON";
        }
        try {
          if (kind === "rule") {
            const rule: CreateDataRule = {
              rule_id: String(payload.rule_id || randomUUID()),
              collection: String(payload.collection || ""),
              field: String(payload.field || ""),
              type: (String(payload.type || "custom") as CreateDataRule["type"]),
              condition_summary: String(payload.condition_summary || ""),
              system_message_template: String(
                payload.system_message_template || "",
              ),
              source_ref: String(payload.source_ref || ""),
              last_verified_commit: String(
                payload.last_verified_commit || "",
              ),
              confidence: "inferred",
            };
            if (!rule.collection || !rule.condition_summary) {
              return "rule requires collection + condition_summary";
            }
            await mergeCreateDataKnowledge(baProjectId, { rules: [rule] });
            return `OK: inferred rule ${rule.rule_id} saved`;
          }
          if (kind === "side_effect") {
            const edge: CreateDataSideEffectEdge = {
              trigger_collection: String(payload.trigger_collection || ""),
              trigger_op: (String(payload.trigger_op || "insert") as
                | "insert"
                | "update"
                | "delete"),
              required_side_effects: Array.isArray(
                payload.required_side_effects,
              )
                ? (payload.required_side_effects as CreateDataSideEffectEdge["required_side_effects"])
                : [
                    {
                      target_collection: String(
                        payload.target_collection || "",
                      ),
                      reason: String(payload.reason || ""),
                      required: payload.required !== false,
                      source_ref: String(payload.source_ref || ""),
                      target_op: "insert",
                    },
                  ],
            };
            if (!edge.trigger_collection || !edge.required_side_effects.length) {
              return "side_effect requires trigger_collection + effects";
            }
            await mergeCreateDataKnowledge(baProjectId, {
              sideEffectEdges: [edge],
            });
            return `OK: side-effect edge ${edge.trigger_op} ${edge.trigger_collection} saved`;
          }
          if (kind === "glossary") {
            const entry: CreateDataGlossaryEntry = {
              term: String(payload.term || ""),
              aliases: Array.isArray(payload.aliases)
                ? payload.aliases.map(String)
                : [],
              collections: Array.isArray(payload.collections)
                ? payload.collections.map(String)
                : [],
              fields: Array.isArray(payload.fields)
                ? payload.fields.map(String)
                : [],
              notes: payload.notes ? String(payload.notes) : undefined,
            };
            if (!entry.term || !entry.collections.length) {
              return "glossary requires term + collections";
            }
            await mergeCreateDataKnowledge(baProjectId, {
              glossary: [entry],
            });
            return `OK: glossary «${entry.term}» saved`;
          }
          return "kind must be rule | side_effect | glossary";
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  };
}
