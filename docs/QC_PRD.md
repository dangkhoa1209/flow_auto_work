# QC Automation Extension — PRD (adapted)

Local Chrome Extension (MV3) + shared Express/Mongo WorkBench backend for QC **Record & Playback** on complex HR UIs (Vue 2/3, PHP, virtual scroll, weak IDs).

## Goals

- Record clicks/inputs as **selector context** (not a single brittle CSS selector).
- Playback with **auto-heal** + `waitForElement` (MutationObserver, ≤10s).
- Modular **Flows** composed into **Test Cases** with loop + Faker templates.
- Run on the **current browser tab** (reuse QC’s manual login cookies).

## Out of scope

- Assertions / Verify modules
- Playwright / CI export

## Stack (this repo)

| Layer | Choice |
|-------|--------|
| Extension UI | Vue 3 Side Panel |
| Extension core | MV3 Service Worker + Content Script + injected page script |
| Backend | Existing Express (`src/`) — **not** NestJS |
| DB | Same MongoDB, collections `qc_*` only |
| Web manage UI | `web/` route `/qc` (CRUD); Record/Play stays in extension |

## Separation from Dev flow

- Shared: login JWT, Express process, Mongo connection.
- Separate: `/api/qc/*`, role `qc`, header `X-Qc-Project`, no GitLab PAT/clone, no job queue.

## Auth

1. Same WorkBench login.
2. User must have `"qc"` in `roles` (“I am QC”).
3. Middleware `requireQc` on `/api/qc/*`; workspace GitLab binding is skipped for these paths.

## Core features

1. **Context-aware record + auto-heal playback** — see [QC_ARCHITECTURE.md](./QC_ARCHITECTURE.md).
2. **Modular flows + session reuse** — compose flows; navigate resumes via `chrome.storage.session`.
3. **Dynamic variables + Faker** — expand `{{faker…}}` / `{{var}}` in Side Panel before Play; loop N times.
4. **Edge cases** — override `confirm`/`alert`; file upload via sample-files API + DataTransfer.

## Phases

| Phase | Deliverable |
|-------|-------------|
| 0 | Docs + role/middleware + module skeleton |
| 1 | MV3 message passing + session storage |
| 2 | Record engine + save flows |
| 3 | Playback + navigation resume + flow chaining |
| 4 | Faker/loop, web CRUD, sample uploads |
