# API layering (HTS-adapted)

Flow API keeps **Express + native Mongo** (no Mongoose / tsoa). Patterns adapted from `ft_hts_be`:

| Layer | Responsibility |
|-------|----------------|
| **Routes** | Method + path + middleware only (`api/routes`) |
| **Controllers** | HTTP parse → module → `res.formatter.*` |
| **Modules** | Domain rules; call **models** + **plugins** |
| **Models** | Persistence (`createModel`, soft-delete, soft-unique indexes) |
| **Plugins** | Integrations + `response-formatter` / `fetch` |

## Soft-delete + indexes (important)

All domain collections use soft-delete (`deleted` / `deletedAt`).

**Unique indexes** use `partialFilterExpression: { deleted: false }` (`softUnique`) so a soft-deleted username / slug / job / script **does not** block creating the same key again.

Boot (`ensureAllModelIndexes`) drops legacy full uniques (`gitlabUsername_1`, `slug_1`, `ws_project_issue_unique`, …) then recreates soft-unique indexes.

Reads use `withActive(filter)` or model `find*` (auto-excludes soft-deleted).

Auth refresh sessions stay hard-delete + TTL (not soft-deleted).

## Response formatter

JSON controllers use `res.formatter.*`. Web/extension unwrap `{ success, data }`.

## Models

See `src/models/` — `connection` (Mongo boot), jobs/chat/notes (+ `jobStats` aggregations), `qc.ts`, workspace_*, ba_*, build_*, stats_analysis_cache.
