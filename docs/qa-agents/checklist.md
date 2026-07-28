# QA Agents — Checklist hạng mục đã làm

> Cập nhật: 2026-07-29  
> Tham chiếu: [`technical-spec.md`](./technical-spec.md), [`current-status.md`](./current-status.md)

Chú thích: `[x]` = đã có trong repo · `[ ]` = chưa / out of MVP

---

## Phase 0 — Skeleton

- [x] Scaffold `qa-agents/` (Express, tsconfig, entry `index.ts`)
- [x] Scaffold `qa-web/` (Vue 3 + Vite + Pinia + Ant Design Vue)
- [x] Scripts npm: `start:qa`, `dev:qa`, `dev:qa-web`, `install:qa-web`, `build:qa-web`, `test:qa`
- [x] Port riêng `QA_PORT` (default 8788) trong Flow `config.ts` + `.env.example`
- [x] Health `GET /health`
- [x] SSE hub riêng (`qa-agents/src/realtime/hub.ts`) + `GET /api/events`
- [x] Mount reuse Flow routes: `/api/auth`, `/api/me`, `/api/projects`
- [x] Mở rộng `JobRecord`: `kind: "qa"`, `qa?: QaRunState`
- [x] Status: `awaiting_qa_review`, `needs_human_intervention`
- [x] Helpers: `newQaJobId()`, `isQaJob()`
- [x] Coding `listJobDocs` / `listJobs` / restore / fail-interrupted **loại trừ** QA jobs
- [x] Không đụng / không phình coding `src/queue.ts` cho QA execution

---

## Phase 1 — Config + Presets + Job shell

- [x] Collection `qa_project_configs` + upsert/get
- [x] Collection `qa_account_presets` + CRUD
- [x] Password preset mã hóa `encryptSecret` / `decryptSecret`
- [x] `lastUsedAt` khi resolve credentials
- [x] API `GET/PUT /api/qa/config`
- [x] API CRUD `/api/qa/presets`
- [x] Tạo job `kind: "qa"` + enqueue
- [x] `QaJobQueue` lane theo `workspaceProjectId`
- [x] UI Config (staging, login fields, limits, presets)
- [x] UI Trigger (URL, preset, testcase, list jobs)

---

## Phase 2 — Login bypass + MCP

- [x] `login/bypass.ts` — POST staging login
- [x] Extract token theo `tokenJsonPath` (`extractJsonPath`)
- [x] Không log password / JWT thô
- [x] Cursor `Agent.create` / `resume` với `mcpServers.chrome-devtools`
- [x] MCP args headless: `npx -y chrome-devtools-mcp@latest --headless`
- [x] Truyền lại `mcpServers` trên resume/send
- [x] Prompt inject JWT vào `localStorage` trước navigate
- [x] engines Node ≥ 22.12 trong `qa-agents/package.json`

---

## Phase 3 — ReAct E2E + capture + Review

- [x] Prompt ReAct: AXTree hiện tại, max actions, timeout
- [x] Outcome markers `<<<QA_DONE>>>` / `<<<QA_NEED_HELP>>>`
- [x] Parse outcome → actionLog / console / network / draft
- [x] Lưu screenshot base64 → `qa-agents/artifacts/{jobId}/`
- [x] SSE progress + job/screenshot events
- [x] Status `awaiting_qa_review` / `needs_human_intervention`
- [x] API `POST .../adjust` (note → continue cùng `agentId`)
- [x] UI Review: capture, live progress, Điều chỉnh, Kill
- [x] Serve artifact `GET /api/qa/artifacts/:jobId/:file`

---

## Phase 4 — Approve → GitLab Issue

- [x] `uploadProjectFile` (multipart GitLab uploads)
- [x] Template markdown cứng (`plugins/issue/markdown.ts`)
- [x] `createIssue` reuse Flow (+ `milestoneId`)
- [x] Approve: chọn assignee / milestone / labels tay
- [x] Job `succeeded` + `createdIssueUrl` — **dừng** (không enqueue coding)
- [x] API `GET /api/qa/meta` (members, labels, milestones)

---

## Phase 5 — Hardening

- [x] Concurrency cap `maxConcurrentSessions` (config UI)
- [x] Kill / cancel agent run
- [x] Boot restore `queued` QA jobs; fail `running` khi restart
- [x] `maskSecrets` trong progress logs
- [x] Artifact cleanup TTL 7 ngày
- [x] Unit tests: token path, parse outcome, markdown, mask secrets (`npm run test:qa`)

---

## Frontend auth / UX (bổ sung sau skeleton)

- [x] Login UI giống coding WorkBench (Sign in / Register, glow, logo)
- [x] `authApi` + `useAuthStore` mirror Flow
- [x] Session bootstrap: refresh access token trước khi gọi `/api/qa`
- [x] Gate `session.ready` + bắt buộc chọn `X-Flow-Project`
- [x] Màn thông báo khi chưa có project membership

---

## Spec / Out of MVP — chưa làm

- [ ] Source map resolution (minified → source gốc)
- [ ] Dual-model orchestration (Haiku navigate + Sonnet report)
- [ ] Prompt caching Anthropic/OpenAI explicit
- [ ] Auto-enqueue coding agent sau khi tạo Issue
- [ ] OAuth GitLab riêng (hiện PAT project)
- [ ] Shared monorepo package cho LoginView (tránh copy UI)
- [ ] Capture CDP “deep” ngoài báo cáo agent (initiator tracking đầy đủ)
- [ ] Checklist demo E2E staging thật (phụ thuộc env người dùng)

---

## Definition of Done (MVP) — đối chiếu

| Tiêu chí | Trạng thái |
|---|---|
| Nhiều project GitLab: config + presets riêng | [x] |
| Login bypass → ReAct staging → capture console/network/screenshot | [x] (cần staging + preset thật để verify E2E) |
| Review bắt buộc; Adjust tiếp; Approve tạo Issue đúng template | [x] |
| Coding Workbench không bị ảnh hưởng / không gọi coding queue | [x] |
