# Flow Auto Work — Ghi chú phát triển

Tài liệu ghi lại những gì đã xây trong project (local orchestrator GitLab + Cursor SDK + UI).

## Mục tiêu

- Làm task GitLab trên repo `aihr_v3` bằng Cursor SDK (local).
- Điều khiển **qua UI** (`npm run dev` = nodemon; không auto-run job khi boot).
- Clarify / Q&A / tiến trình Cursor trên UI.
- Commit trên **nhánh hiện tại** (không checkout `main`, không tạo `auto/*`).
- Khi agent xong: status **`awaiting_handoff`** — chờ user assign / thêm labels thủ công (**không** auto).
- Handoff xong → `succeeded`. Chỉ comment GitLab khi xong: `Task work 100% by AI` + summary **tiếng Việt**.
- Tab **Thống kê**: todolist theo ngày (`Asia/Ho_Chi_Minh`).
- Theme UI tối; loading spinner trên mọi chỗ fetch.

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
  → Cursor agent (stream → progress UI)
  → clarify loop (UI only, không comment GitLab)
  → commit local (nếu dirty, excl. WIP) → awaiting_handoff
  → comment "Task work 100% by AI" + summary VI
  → user handoff (add_labels + assignee) → succeeded
  (không push / không MR)
```

**Boot**: server + UI. Không startup scan. Webhook mặc định không enqueue (`WEBHOOK_AUTO_ENQUEUE=false`).

---

## Job status

| Status | Ý nghĩa |
|--------|---------|
| `queued` / `running` | Đang chờ / đang chạy agent |
| `awaiting_clarification` | Agent hỏi — trả lời trên UI |
| `awaiting_handoff` | Code xong — chờ assign/labels thủ công |
| `succeeded` | Đã handoff |
| `failed` | Lỗi / force stop / restart giữa chừng |
| `awaiting_diff_approval` | Legacy — migrate → succeeded khi boot |

---

## UI

| Tab | Nội dung |
|-----|----------|
| Work | 3 cột: Tasks+Jobs · Detail+Progress · Assign+Clarify |
| Done chờ | Jobs `awaiting_handoff`; handoff = assignee + **add** labels (không set/remove) |
| Thống kê | `GET /api/stats/daily` — đếm / list theo ngày |

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
| POST | `/api/jobs/start` | `{ mode, issueIids?, completion }` |
| GET | `/api/jobs` | list jobs |
| GET | `/api/jobs/:id` | job + chat |
| GET | `/api/jobs/:id/progress` | stream log Cursor |
| POST | `/api/jobs/:id/kill` | force stop |
| POST | `/api/jobs/:id/clarify` | trả lời agent |
| POST | `/api/jobs/:id/ask` | Q&A |
| POST | `/api/jobs/:id/completion-actions` | handoff → succeeded (`labelMode: add`) |
| GET | `/api/stats/daily?days=14` | todolist theo ngày |
| GET | `/api/meta/members` | members |
| GET | `/api/meta/labels` | labels |

---

## Backend modules

| Path | Vai trò |
|------|---------|
| `src/index.ts` | Boot + migrate legacy diff-approval |
| `src/server.ts` | Hono: health, API, webhook, static UI |
| `src/api/routes.ts` | REST API |
| `src/queue.ts` | serial jobs → awaiting_handoff |
| `src/agent/run.ts` | Cursor SDK + stream progress |
| `src/agent/progress.ts` | buffer tiến trình theo jobId |
| `src/agent/prompt.ts` | prompt; DONE summary tiếng Việt |
| `src/db/mongo.ts` | jobs / notes / chat (fix upsert `source`) |
| `src/git/prep.ts` | stay branch, scrub WIP, parse porcelain |
| `src/gitlab/linked-context.ts` | linked context + clean comments |
| `src/clarify/ui-wait.ts` | chờ clarify UI |
| `public/index.html` | toàn bộ UI |
| `nodemon.json` | `npm run dev` watch |

### Comment GitLab

Chỉ **một** comment khi agent xong:

```
Task work 100% by AI

<summary tiếng Việt>
```

Không comment Start / Clarify / Fail.

### Handoff labels

`labelMode: "add"` → `add_labels` (vd. Ready to Release). **Không** replace / remove label cũ.

---

## Git / commit

- Branch đang checkout.
- Message: `feat #<iid> <title>`.
- Exclude WIP: `permission.js`, `directives/index.js` (`COMMIT_EXCLUDE_PATHS`).
- Không push / MR.

---

## Config (`.env`)

```env
STARTUP_SCAN=false
WEBHOOK_AUTO_ENQUEUE=false
COMMIT_EXCLUDE_PATHS=resources/js/composables/permission.js,resources/js/directives/index.js
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
