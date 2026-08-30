# Flow Auto WorkBench

Orchestrator **local**: login password → GitLab projects (clone + PAT) → UI Run → Cursor SDK → **commit qua GitLab API** → **`awaiting_handoff`** → assign/labels → `succeeded`.

> Chi tiết: [`docs/NOTES.md`](docs/NOTES.md) · Deploy: [`docs/DEPLOY.md`](docs/DEPLOY.md) · Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md) · Mục lục: [`docs/README.md`](docs/README.md).

## Tính năng chính

| Phần | Chi tiết |
|------|----------|
| UI | Vue 3 + Ant Design Vue + Tailwind (light) · Work / Handoff / Thống kê / Settings |
| Jobs | Queue serial; Force Stop / Reset window; đổi status / xóa; progress Cursor live |
| Tasks | Assign cho bạn · filter Milestone · mở theo `#iid` · Related/child preview (không mở job) |
| Done | 1 issue = 1 job; Dev Notes; Run / Run all; Hotfix (adhoc) |
| Handoff | Assign + **add** labels → `succeeded` (có thể merge → base branch) |
| Comment | Khi xong có code change: `AI-Generated` + summary tiếng Việt |
| Git | Work branch workspace (hoặc `feat/…`); commit qua GitLab API (author = PAT); merge local + push target |
| Stack | Hono API · Mongo · Cursor SDK local · **SSE realtime** (`/api/events`) |

## Flow dự án (end-to-end)

```
Login (GitLab PAT + Cursor API key, mã hóa)
  → Chọn project + local repo path + base / work branch
  → Work: chọn Task / Hotfix / #iid → (optional) Dev Notes, Docs-first
  → Run → JobQueue (serial)
       → on-start labels (optional)
       → [optional] Docs phase → awaiting_docs_approval → Approve
       → Cursor agent (+ clarify trên UI)
       → commit qua GitLab API (nếu dirty) + sync local
       → awaiting_handoff + comment GitLab (nếu có đổi code)
  → Handoff: assign / labels (± merge → base)
  → succeeded
```

Follow-up chat trên job Done: sửa thêm; **không đổi code** → giữ status Done/handoff.

Chi tiết trạng thái và UI: [`docs/NOTES.md`](docs/NOTES.md).

## Flow context → Agent (khi bấm Run)

Khi **Run**, orchestrator đánh giá **context quality** rồi mới (có thể) dựng MISSION prompt. Cursor Agent chạy với `cwd` = local repo.

```
Run / Chat follow-up (code)
  → nếu job.contextQuality.level === "good" → dùng mark (không đánh giá lại)
  → ngược lại assessContextQuality(title + desc + Dev Notes + chat Human [+ tin nhắn mới])
       ├─ bad        → chat báo thiếu gì · STOP (không Cursor) · ghi mark bad
       ├─ searchable → ghi mark · prompt ép grep · gọi agent
       └─ good       → ghi mark sticky · prompt skip search · gọi agent
```

| Cấp | Ý | Orchestrator |
|-----|---|--------------|
| **Good** | Route/file/model + I/O, bug có repro + expected + log, **hoặc Dev Notes rõ ràng** | Code thẳng; **lần sau bỏ qua assess** |
| **Searchable** | Có mỏ neo (UI text, field, API) | Search 1–2 nhịp; lần sau **vẫn assess** (có thể lên good) |
| **Bad** | Ngắn / cảm tính / thiếu kỹ thuật | **Chặn** + chat; lần sau **assess lại** |

UI: tag Context + link **Xem tiêu chuẩn** (modal). Chi tiết: [`docs/NOTES.md`](docs/NOTES.md) § Agent context.

**Không gửi vào prompt:** media, toàn bộ codebase, secrets. Linked = issue links + `#mention` + excerpt comments.

Code: `apps/api/src/plugins/agent/context-quality.ts` · `apps/api/src/queue.ts` · `apps/api/src/plugins/agent/run.ts` · `apps/api/src/plugins/agent/prompt.ts` · `apps/api/src/plugins/gitlab/linked-context.ts`.

## Chạy

```bash
cp .env.example .env   # điền secrets
npm install            # workspaces: api + web + extension + shared
npm run build:web      # Vue → apps/web/dist
npm run dev            # turbo: API :8787 + Vite :5173
# Chỉ API (serve apps/web/dist nếu đã build):
#   npm run dev:api
# Extension QC:
#   npm run dev:extension
```

| Command | Mô tả |
|---------|--------|
| `npm run dev` | Turbo — API + web |
| `npm run dev:api` | Nodemon API (`@flow/api`) |
| `npm run dev:web` | Vite UI (proxy API) |
| `npm run build:web` | Build Vue → `apps/web/dist` |
| `npm start` | Chạy một lần (không watch) |
| `npm run typecheck` | Turbo typecheck |

> Sửa `apps/web/src` rồi chạy qua `:8787` → cần `npm run build:web` (hoặc dùng `dev:web`).

Monorepo: `apps/api` · `apps/web` · `apps/extension` · `packages/shared` (Turbo + npm workspaces).

### Thử nhanh sau khi pull

```bash
npm install
npm run build:web
npm run dev
# mở http://127.0.0.1:8787 → login → chọn project
# DevTools → Network: 1 connection EventStream `/api/events` (không spam /api/status)
```

| Thử | Cách |
|-----|------|
| Context quality | Chọn task → **Xem tiêu chuẩn** · Dev Notes rõ → Good · Run khi Bad → chat chặn |
| Force Stop / Reset window | Header Chat agent khi đang Run hoặc Gửi |
| Realtime | Run job → Progress/status cập nhật qua SSE, không poll |

Deploy / reverse proxy SSE / tunnel: [`docs/DEPLOY.md`](docs/DEPLOY.md).

### Auth session

- **Access token** ~10 phút (`Authorization: Bearer …`)
- **Refresh token** ~30 ngày (Mongo `auth_refresh_sessions`, rotate mỗi lần refresh)
- F5 / restart server: UI tự refresh access; hết 30 ngày mới login lại
- Cần `FLOW_SECRETS_KEY` (ký JWT + mã hóa PAT)

## Job status

`draft` → `queued` → `running` → (`awaiting_clarification` | `awaiting_docs_approval`) → `awaiting_handoff` → `succeeded`  
(hoặc `failed`)

## Bảo mật

- `.env` trong `.gitignore` — không commit token/key  
- Chỉ commit `.env.example` (placeholder)  
- PAT / Cursor key user: mã hóa khi lưu Mongo
