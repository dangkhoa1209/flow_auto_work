# Flow Auto WorkBench — Agent notes

Internal orchestrator: Vue web (`apps/web`), API (`apps/api`), Cursor extension.

## Language

- **All user-facing copy is English** — UI labels, toasts, empty states, confirmations, API error messages shown to clients, placeholders.
- Chat replies to the user in this repo may follow the user’s language; product strings must stay English.
- Do not add new Vietnamese UI strings. When touching a screen, translate remaining Vietnamese on that surface to English.

## Cursor rules

Project rules live in `.cursor/rules/*.mdc`. Prefer those over inventing new conventions.

Notable:

- `english-ui.mdc` — English-only product copy (always on)
- `flow-workbench-ux.mdc` — Workbench UX patterns
- `project-nested-context.mdc` — when editing under `project/<user>/<slug>/source`
- `graphify.mdc` — graphify usage

## Nested customer sources

Paths under `project/` are customer checkouts. Load that tree’s `.cursor/rules` and `AGENTS.md` when working there; do not assume WorkBench app rules alone.

## Roles (Build / Devops)

- Console access: `admin` | `devops` | `dev`
- Script config (create/edit/delete/toggle): `devops` | `admin` only

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- WorkBench dual corpus: root `graphify-out/` is this app; customer checkouts use **sibling** `project/<user>/<slug>/graphify-out/` (never inside `source/`). Rebuild: `scripts/graphify-work-project.sh <user>/<slug>`. Auto after clone/BA pull. **BA Chat / workflow / Work tasks** inject a graphify query map into the agent prompt before Cursor runs (Work also attaches `code_map_*` tools). **Create issue** is chat-only (no source / graphify). Details in `.cursor/rules/graphify.mdc`.
