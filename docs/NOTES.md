# Flow Auto Work — Ghi chú phát triển

Tài liệu ghi lại những gì đã xây trong project (local orchestrator GitLab + Cursor SDK + UI).

## Mục tiêu

- Orchestrator GitLab + Cursor SDK + UI — **multi-user / multi-project**.
- Mỗi dev login bằng **GitLab username**; nhập **GitLab PAT + Cursor API key** (mã hóa AES-256-GCM trước khi lưu Mongo).
- **Cursor model** chọn trên UI (Settings / modal Run); lưu theo user (`auto` hoặc model cụ thể).
- **Processing label** chọn trên UI Settings (mặc định `On-processing`); thêm khi Start, bỏ khi handoff.
- Một user join nhiều project; mỗi membership có **nhánh project (base)** + **nhánh làm việc (optional)**.
- **Nhánh làm việc trống** → khi Run tự tạo `feat/<iid>/<short-english-slug>` từ nhánh project rồi commit.
- **Nhánh làm việc có giá trị** → chỉ checkout & commit trên nhánh đó.
- Khi agent xong: **`awaiting_handoff`** → user có thể **Merge → nhánh project** (local; conflict → AI fix) rồi assign/labels thủ công.
- Tab **Thống kê**; Tasks group theo **Milestone**. Click job trong thống kê → modal **Code Diff**.
- Cột giữa Work: tabs **Detail | Diff | Commits | Progress** — diff theo `base...job.branch`, list file +/−, highlight. Done chờ cũng có panel Diff trước merge.

---

## Kiến trúc hiện tại

```
UI (http://127.0.0.1:8787)
  ├─ Work
  │    ├─ Tasks / Start / Jobs (+ Force Stop)
  │    ├─ Task detail + Comments + tiến trình Cursor
  │    ├─ Assign/Labels (set ngay trên GitLab)
  │    └─ Clarify / Q&A
  ├─ Done chờ — list awaiting_handoff → assign + add labels → Xác nhận
  ├─ Thống kê — todolist theo ngày
  └─ ⚙ Settings — labels khi Start + prefill handoff (không auto)

JobQueue (serial)
  → on-start labels (optional)
  → [optional] Docs phase (feature docs .md/.mdc) → awaiting_docs_approval → Approve
  → Cursor agent code (AiHR rules + approved docs) → clarify loop
  → commit local (nếu dirty) → awaiting_handoff
  → comment "Task work 100% by AI" + summary VI
  → user handoff (add_labels + assignee) → succeeded
  (không push / không MR)
```

**Tasks UI**: group + filter theo **GitLab Milestone**.

**Onboarding**: GitLab PAT (link lấy token trên UI) → chọn project (+ local path) → **nhánh project** + **nhánh làm việc optional**. Cursor key chỉ hỏi khi **Run** nếu chưa có (link Dashboard Integrations trên UI).

**Boot**: server + UI. Jobs chỉ start từ UI. Không startup scan.

---

## Job status

| Status | Ý nghĩa |
|--------|---------|
| `queued` / `running` | Đang chờ / đang chạy agent |
| `draft` | 1 job/issue — đang viết Dev Notes, chưa run |
| `awaiting_clarification` | Agent hỏi — trả lời trên UI |
| `awaiting_docs_approval` | Docs feature (`.md`/`.mdc` trong `docs/`) xong — PM duyệt trên UI rồi mới code |
| `awaiting_handoff` | Code xong — chờ assign/labels thủ công |
| `succeeded` | Đã handoff |
| `failed` | Lỗi / force stop / restart giữa chừng |
| `awaiting_diff_approval` | Legacy — migrate → succeeded khi boot |

---

## UI

| Tab | Nội dung |
|-----|----------|
| Work | 3 cột: Tasks (group theo Milestone) + Jobs · Detail+Dev Notes+Docs review · Assign+Clarify |
| Done chờ | Jobs `awaiting_handoff`; handoff = assignee + **add** labels (không set/remove) |
| Thống kê | `GET /api/stats/daily` — đếm / list theo ngày |

### Cột giữa — user flow

1. **Fetch & Review** — click task → ensure **1 job** (`draft` nếu mới) + đọc GitLab.
2. **Dev Notes** — ghi chú kỹ thuật trên job (`devNotes` Mongo). **Save notes** hoặc **Run**.
3. **Docs trước code** (optional checkbox) — Phase A: đọc/sửa **feature docs** AiHR (`docs/modules/...`, `.md` hoặc `.mdc`, không theo issue). Code phase bắt buộc theo **AiHR rules** (`.cursor/rules/**/*.mdc` + AGENTS.md + skill). Status `awaiting_docs_approval` → xem docs trên UI → **Approve → Code**.
4. **Run** — re-run cùng job (`runCount++`), giữ chat/context.
5. **Run tất cả** — mọi task assigned: tạo job nếu thiếu (kể cả draft), re-run; **bỏ qua** đang queued/running/clarify.

`devNotes` chỉ trên job Mongo (không post GitLab). Prompt: **DEV NOTES (HIGHEST PRIORITY)**.

Docs gate API: `GET /api/jobs/:id/docs`, `POST /api/jobs/:id/approve-docs`, `POST /api/jobs/:id/rerun-docs`.

- Dark theme (CSS variables).
- Dropdown autocomplete (gõ để lọc).
- Loading spinner: Refresh, task detail, jobs, chat, stats, nút action.

### Settings (`localStorage` `flow_auto_work_settings`)

| Mục | Ý nghĩa |
|-----|---------|
| Labels khi Start | `add_labels` trước agent |
| Prefill handoff | assignee / labels gợi ý form Done chờ (không auto apply) |

---

## API chính

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/status` | health, queue, mongo |
| GET | `/api/tasks` | open issues assigned |
| GET | `/api/tasks/:iid` | detail + notes + related |
| POST | `/api/tasks/update` | assign / labels ngay |
| POST | `/api/jobs/start` | `{ mode: selected\|manual\|drafts\|auto, issueIid?, issueIids?, devNotes?, completion }` |
| POST | `/api/jobs/ensure` | tạo/mở job duy nhất cho issue (`draft`) |
| PUT | `/api/jobs/:id/dev-notes` | lưu Dev Notes trên job |
| GET | `/api/jobs` | list jobs |
| GET | `/api/jobs/:id` | job + chat |
| GET | `/api/jobs/:id/progress` | stream log Cursor |
| POST | `/api/jobs/:id/kill` | force stop |
| POST | `/api/jobs/:id/clarify` | trả lời agent |
| POST | `/api/jobs/:id/ask` | Q&A |
| POST | `/api/jobs/:id/completion-actions` | handoff → succeeded (`labelMode: add`) |
| GET | `/api/stats/daily?days=90` | todolist: chỉ ngày có task · `months → weeks → days` |
| GET | `/api/meta/members` | members |
| GET | `/api/meta/labels` | labels |

---

## Backend modules

| Path | Vai trò |
|------|---------|
| `src/index.ts` | Boot + migrate legacy diff-approval |
| `src/server.ts` | Hono: health, API, static UI |
| `src/api/routes.ts` | REST API |
| `src/queue.ts` | serial jobs → awaiting_handoff |
| `src/agent/run.ts` | Cursor SDK + stream progress |
| `src/agent/progress.ts` | buffer tiến trình theo jobId |
| `src/agent/prompt.ts` | MISSION + DEV NOTES (highest) + BUSINESS REQUIREMENTS; DONE summary VI |
| `src/db/mongo.ts` | jobs / notes / chat (fix upsert `source`) |
| `src/git/prep.ts` | stay branch, scrub WIP, parse porcelain |
| `src/gitlab/linked-context.ts` | linked context + clean comments |
| `src/clarify/ui-wait.ts` | chờ clarify UI |
| `public/index.html` | toàn bộ UI |
| `nodemon.json` | `npm run dev` watch |

### Comment GitLab

Chỉ comment khi run **có thay đổi code** (commit mới / HEAD đổi):

```
Task work 100% by AI

<summary tiếng Việt>
```

Không comment nếu không có diff; không comment Start / Clarify / Fail.

### Handoff labels

`labelMode: "add"` → `add_labels` (vd. Ready to Release). **Không** replace / remove label cũ.

---

## Git / commit

- Branch đang checkout.
- Message: `feat #<iid> <title>`.
- Commit toàn bộ thay đổi local (không exclude path).
- Không push / MR (trừ merge work→project khi handoff).

---

## Config (`.env`)

```env
STARTUP_SCAN=false
# ON_COMPLETE_* chỉ còn seed prefill UI (không auto)
```

`.env` **không** commit.

---

## Chạy nhanh

```bash
cp .env.example .env
npm install
npm run dev   # nodemon → http://127.0.0.1:8787/
```

CLI: `npm run list-tasks`, `npm run scan`, `npm run typecheck`.

---

## Lịch sử thay đổi (tóm tắt)

1. Orchestrator UI-primary + Cursor local + Mongo jobs.
2. Done = local commit; bỏ push/MR / diff-approval gate.
3. `awaiting_handoff` + tab Done chờ + thống kê ngày.
4. Comment chỉ khi xong (`Task work 100% by AI` + summary VI).
5. Progress stream Cursor; dark UI; loading fetch; nodemon.
6. Handoff add labels only; fix Mongo `source` upsert conflict.
