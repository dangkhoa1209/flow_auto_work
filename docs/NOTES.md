# Flow Auto Work — Ghi chú phát triển

Tài liệu ghi lại những gì đã xây trong project (local orchestrator GitLab + Cursor SDK + UI).

Setup nhanh: [README.md](../README.md) · Deploy: [DEPLOY.md](./DEPLOY.md) · Roadmap: [ROADMAP.md](./ROADMAP.md).

## Mục tiêu

- Orchestrator GitLab + Cursor SDK + UI — **multi-user / multi-project**.
- Mỗi dev login bằng **GitLab username**; nhập **GitLab PAT + Cursor API key** (mã hóa AES-256-GCM trước khi lưu Mongo).
- **Cursor model** chọn trên UI; lưu theo user (`auto` hoặc model cụ thể).
- **Processing label** trên Settings (mặc định `On-processing`); thêm khi Start, bỏ khi handoff.
- Một user join nhiều project; mỗi membership có **nhánh project (base)** + **nhánh làm việc (optional)**.
- **Nhánh làm việc trống** → khi Run tự tạo `feat/<iid>/…` từ nhánh project rồi commit.
- **Nhánh làm việc có giá trị** → checkout & commit trên nhánh đó (Hotfix cũng tái sử dụng, không tạo branch mới).
- Khi agent xong: **`awaiting_handoff`** → merge (optional) + assign/labels thủ công → `succeeded`.
- Tab **Thống kê**; Tasks filter **Milestone**; Related/child → modal preview.

---

## Kiến trúc hiện tại

```
UI (http://127.0.0.1:8787 — Vue web/dist)
  ├─ Work
  │    ├─ Tasks (assign bạn · Milestone · #iid) / Hotfix / Jobs
  │    ├─ Issue detail · Related preview · Dev Notes · Progress
  │    └─ Chat · Clarify · Force Stop · Reset window
  ├─ Handoff — awaiting_handoff → assign + add labels → succeeded
  ├─ Thống kê
  └─ Settings — project path, branches, Cursor, labels

JobQueue (serial)
  → on-start labels (optional)
  → [optional] Docs phase → awaiting_docs_approval → Approve
  → Cursor agent (context: § Agent context) → clarify loop
  → commit GitLab API (nếu dirty) + sync local → awaiting_handoff
  → comment "AI-Generated" + summary VI (khi có code change)
  → user handoff → succeeded
  (merge work→base vẫn local git + push target; không auto MR)
```

**Onboarding**: GitLab PAT → project (+ local path) → base + work branch optional. Cursor key khi **Run** nếu chưa có.

**Boot**: server + UI. Jobs start từ UI.

---

## Flow dự án (end-to-end)

```
Login → workspace (project + repo path + branches)
  → chọn Task / Hotfix / #iid
  → (optional) Dev Notes, Docs-first
  → Run → JobQueue
       → prepare git
       → dựng MISSION prompt (chat + notes + issue + linked [+ docs])
       → Cursor Agent (create | resume agentId)
       → clarify loop nếu cần
       → commit qua GitLab API + sync local
  → awaiting_handoff → Handoff UI → succeeded
```

Re-run cùng job giữ `agentId` khi resume được. Follow-up trên Done: không đổi code → giữ status cũ.

---

## Agent context (khi bấm Run)

Orchestrator **không** dump codebase vào prompt. Dựng một **MISSION prompt**, Cursor Agent chạy với `cwd` = local repo (tự đọc file qua tools).

### Pipeline

| Bước | Nguồn | Module |
|------|--------|--------|
| **Context quality gate** | issue + Dev Notes + chat Human | `src/agent/context-quality.ts` |
| Git prep | checkout work / feat branch | `src/git/prep.ts` |
| UI chat | Clarify / Q&A gần đây | `formatChatContextForRun` |
| Linked | Issue links + `#mention` + comments | `collectLinkedIssueContext` |
| Dev Notes | `job.devNotes` | Mongo |
| Docs gate | paths đã Approve (code phase) | `job.docsPaths` |
| Prompt | docs hoặc code + **CONTEXT QUALITY** block | `buildWorkPrompt` / `buildDocsPhasePrompt` |
| Agent | create hoặc resume `job.agentId` | `src/agent/run.ts` |

```
Run / follow-up chat (mọi chỗ gọi Cursor để code)
  → nếu job.contextQuality.level === "good" → reuse mark (không assess)
  → else assess → ghi mark lên job
       bad → chat + STOP (không Cursor)
       searchable | good → prompt quality block → agent
```

| Cấp | Persist | Lần sau |
|-----|---------|---------|
| **Good** | `job.contextQuality` | **Skip assess** |
| **Searchable** | mark | Assess lại (có thể lên good) |
| **Bad** | mark | Assess lại sau khi user bổ sung |

**Good** khi: feature đủ route/file/I/O, hoặc bug có repro + expected + log, **hoặc Dev Notes rõ ràng** (≥ ~25 từ + tín hiệu kỹ thuật). UI chỉ hiện tag + link **Xem tiêu chuẩn** (modal), không dump criteria.

### Ưu tiên trong prompt (cao → thấp)

1. **CONTEXT QUALITY** (good/searchable directives)  
2. **UI CHAT REQUESTS**  
3. **DEV NOTES**  
4. **APPROVED FEATURE DOCS**  
5. **BUSINESS REQUIREMENTS**  
6. **Linked / related**  
7. **AiHR rules (chỉ dẫn)**

### Không đưa vào prompt

- Ảnh, upload, media  
- Toàn bộ source tree  
- Secrets / `.env`  
- Child hierarchy Work Item (chỉ links + mention)

### Phase

| Điều kiện | Prompt |
|-----------|--------|
| Docs-first, chưa duyệt | Docs only — `docs/`, không app code |
| Thường / sau Approve | Code — implement + commit `feat #<iid> …` |

Clarify (agent hỏi giữa chừng): `NEED_CLARIFICATION` → UI → `buildResumePrompt` trên cùng window.

---

## Job status

| Status | Ý nghĩa |
|--------|---------|
| `queued` / `running` | Đang chờ / đang chạy agent |
| `draft` | Chưa run, hoặc **Bad Context** đã chặn (bổ sung rồi Run lại) |
| `awaiting_clarification` | Agent hỏi giữa run — trả lời trên UI |
| `awaiting_docs_approval` | Docs feature xong — chờ Approve rồi code |
| `awaiting_handoff` | Code xong — chờ assign/labels |
| `succeeded` | Đã handoff |
| `failed` | Lỗi / force stop |
| `awaiting_diff_approval` | Legacy — migrate khi boot |

---

## UI

| Tab | Nội dung |
|-----|----------|
| Work | Tasks + Jobs · Issue / Progress / Chat · Related preview |
| Handoff | `awaiting_handoff` → assignee + **add** labels |
| Thống kê | `GET /api/stats/daily` |
| Settings | Project, Cursor, labels |

### Cột giữa — user flow

1. Click task → ensure 1 job + đọc GitLab.  
2. Dev Notes trên job Mongo.  
3. Docs-first (optional) → Approve → Code.  
4. Run / Run all (bỏ qua job busy).  
5. Related/child → modal preview (không mở job).

Light theme (Vue + Ant Design Vue + Tailwind).

### Settings (`localStorage` `flow_auto_work_settings`)

| Mục | Ý nghĩa |
|-----|---------|
| Labels khi Start | `add_labels` trước agent |
| Prefill handoff | gợi ý form Handoff (không auto) |

---

## API chính

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/status` | health, queue (one-shot; UI dùng SSE) |
| GET | `/api/events` | **SSE realtime** — `status` · `jobs` · `job` · `progress` · `ping` |
| POST | `/api/auth/login` | Login → `accessToken` (10p) + `refreshToken` (30 ngày) |
| POST | `/api/auth/refresh` | Đổi refresh → access mới (rotate refresh) |
| POST | `/api/auth/logout` | Revoke refresh |
| GET | `/api/tasks` | open issues assigned |
| GET | `/api/tasks/:iid` | detail + notes + related |
| POST | `/api/jobs/start` | enqueue Run |
| POST | `/api/jobs/ensure` | mở/tạo job (fetch theo iid nếu cần) |
| POST | `/api/jobs/adhoc` | Hotfix |
| PUT | `/api/jobs/:id/dev-notes` | Dev Notes |
| PATCH | `/api/jobs/:id/status` | đổi status thủ công |
| DELETE | `/api/jobs/:id` | xóa job + chat/notes |
| GET | `/api/jobs/:id/progress` | log Cursor |
| POST | `/api/jobs/:id/kill` | Force Stop (hủy run + bỏ `agentId`) |
| POST | `/api/jobs/:id/reset-window` | Dừng nếu busy + xóa window; Run/chat/Q&A sau mở cửa sổ mới |
| POST | `/api/jobs/:id/clarify` / `ask` / `continue` | clarify / Q&A / follow-up |
| POST | `/api/jobs/:id/completion-actions` | handoff → succeeded |

---

## Backend modules

| Path | Vai trò |
|------|---------|
| `src/index.ts` | Boot |
| `src/server.ts` | Hono + static `web/dist` |
| `src/api/routes.ts` | REST |
| `src/queue.ts` | serial jobs; inject chat vào Run |
| `src/agent/run.ts` | Cursor SDK + `buildMissionPrompt` |
| `src/agent/prompt.ts` | MISSION prompts |
| `src/agent/context-quality.ts` | Good / Searchable / Bad gate |
| `src/realtime/hub.ts` | Pub/sub in-process → SSE |
| `web/src/realtime/` | EventSource client |
| `web/` | Vue UI |

---

## Realtime (SSE)

UI **không** poll `/api/status` / `/api/jobs` mỗi 1.5s.

```
Browser EventSource → GET /api/events
  ← event: status   (queue / currentJobId)
  ← event: job      (status 1 job)
  ← event: jobs     (enqueue / kill / delete → UI refresh list)
  ← event: progress (Cursor log lines)
  ← event: ping     (heartbeat ~20s)
```

- Không thêm dependency (`EventSource` + `hono/streaming`).
- Proxy: disable buffering trên `/api/events`.

### Agent window

| Action | API | Ý |
|--------|-----|---|
| Force Stop | `POST /jobs/:id/kill` | Hủy run + bỏ `agentId` (kể cả đang chat) |
| Reset window | `POST /jobs/:id/reset-window` | Dừng nếu busy + clear window; Run/Gửi sau mở cửa sổ mới |

---

## Auth / project workspace

- Login: **username + password** (seed `khoadev` / `Khoa.12090`). Optional `AUTH_BYPASS_PASSWORD` trong `.env`.
- Project thuộc user: PAT GitLab + `localPath` + branches + `isActive`; clone vào `project/{user}/{name}/source` (gitignored).
- Run cần clone `ready` (có `.git`); thiếu → block (LEVEL 3).

## Git / commit

- Work branch workspace hoặc `feat/…`.  
- Message: `feat #<iid> <title>` · adhoc: `hotfix: …` · docs: `docs #<iid> …`.  
- **Commit qua GitLab Commits API** (author = chủ PAT); không `git commit` local làm nguồn sự thật.  
- Sau API: fetch + reset local tới SHA GitLab (merge/handoff thấy tip đúng).  
- Merge work → base: vẫn local `git merge` + `git push` target (trước merge có fetch source từ origin).  
- Không auto mở MR.

---

## Config (`.env`)

```env
STARTUP_SCAN=false
```

`.env` **không** commit.

---

## Chạy nhanh

Xem [README.md](../README.md).

---

## Lịch sử thay đổi (tóm tắt)

1. Orchestrator UI-primary + Cursor local + Mongo jobs.  
2. Done = GitLab API commit (PAT author) + sync local; merge/handoff vẫn local.  
3. `awaiting_handoff` + Handoff UI + thống kê.  
4. Comment `AI-Generated` + summary VI.  
5. Vue workbench (light) · Hotfix · job status/delete · Related preview.  
6. Agent context: chat + notes + linked + docs gate có ưu tiên rõ.
