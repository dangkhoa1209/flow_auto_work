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
