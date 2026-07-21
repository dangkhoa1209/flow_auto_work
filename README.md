# Flow Auto Work

Orchestrator chạy **local**: nhận task GitLab → Cursor SDK làm trên repo `aihr_v3` → commit trên **nhánh hiện tại** → push + mở **Merge Request** chờ review. Thiếu thông tin thì hỏi qua **Teams chat 1:1**.

## Đã làm gì (v1)

| Phần | Chi tiết |
|------|----------|
| Webhook GitLab | `POST /webhooks/gitlab` — verify `X-Gitlab-Token`, filter Issue Hook (assign/update), dedup theo project+iid |
| Tunnel | `scripts/start.sh` chạy server + `cloudflared` quick tunnel |
| Startup scan | Khi service lên: quét open issues đang assign → enqueue (song song với webhook) |
| List/scan CLI | `npm run list-tasks` / `npm run scan` |
| Job queue | 1 job tại một thời điểm; state `data/jobs/*.json` |
| Cursor SDK | Agent local `cwd = AIHR_REPO_PATH`; clarify → Teams → `Agent.resume` |
| Git | **Không đổi nhánh** — làm trên branch đang checkout; commit `feat #<iid> <title>` |
| Commit exclude | Không commit WIP: `permission.js`, `directives/index.js` (không gitignore) |
| MR | Push branch hiện tại + tạo MR vào default branch; comment Issue |
| Guard | Skip label `auto-work:skip` / `wip-human`; placeholder `.env` bị chặn |

## Kiến trúc

```
GitLab Issue Hook ──cloudflared──► POST /webhooks/gitlab
                                         │
Startup scan (API) ──────────────────────┤
                                         ▼
                                   Serial JobQueue
                                         ▼
                              Cursor SDK (local agent)
                         ┌───────────────┴───────────────┐
                         │ NEED_CLARIFICATION            │ DONE
                         ▼                               ▼
                   Teams 1:1 ask/wait              scrub exclude paths
                         │                               │
                         └──► Agent.resume               ▼
                                              push + create MR + comment
```

## Cấu trúc repo

```
src/
  index.ts              # boot server + startup scan
  server.ts             # Hono: /health, /webhooks/gitlab
  config.ts             # env (zod)
  queue.ts              # serial jobs
  job-store.ts          # data/jobs/*.json
  agent/prompt.ts       # prompt + DONE / NEED_CLARIFICATION markers
  agent/run.ts          # Cursor SDK create / resume / wait
  git/prep.ts           # stay on current branch, scrub exclude paths
  gitlab/               # verify, filter, client, startup-scan, scan-config
  teams/                # Graph send + poll reply
scripts/
  start.sh / stop.sh    # server + cloudflared
  list-tasks.ts         # list / enqueue CLI
  selfcheck.ts
.env.example            # template (commit được)
.env                    # secrets — KHÔNG commit (.gitignore)
```

## Setup

```bash
cp .env.example .env
# Điền thật: CURSOR_API_KEY, GITLAB_TOKEN, GITLAB_ASSIGNEE_USERNAME, …
npm install
chmod +x scripts/start.sh scripts/stop.sh
```

### `.env` quan trọng

| Biến | Bắt buộc | Mục đích |
|------|----------|----------|
| `CURSOR_API_KEY` | Để chạy agent | [Cursor Integrations](https://cursor.com/dashboard/integrations) |
| `GITLAB_TOKEN` | Có | PAT scope `api` |
| `GITLAB_ASSIGNEE_USERNAME` | Có | Username GitLab (vd. `khoahdjobtestvn`) |
| `ALLOWED_PROJECT_PATH` | Có | `kiemnv/aihr_v3` |
| `AIHR_REPO_PATH` | Có | Path clone local `aihr_v3` |
| `GITLAB_WEBHOOK_SECRET` | Webhook | Khớp secret trên GitLab |
| `STARTUP_SCAN` | Không (default true) | Quét issue khi start |
| `COMMIT_EXCLUDE_PATHS` | Không | File không đưa vào commit auto |
| `TEAMS_*` | Khi cần clarify | Graph + `TEAMS_CHAT_ID` |

**Lấy GitLab token:** Preferences → [Access Tokens](https://gitlab.com/-/user_settings/personal_access_tokens) → scope **`api`**.

## Chạy

```bash
# Chỉ kiểm tra lấy được task (không cần Cursor key)
npm run list-tasks

# Server + startup scan (cần Cursor key để làm job)
npm run dev

# Server + cloudflared tunnel
./scripts/start.sh
./scripts/stop.sh
```

Health: `curl http://127.0.0.1:8787/health`

### GitLab webhook

1. `./scripts/start.sh` → copy URL `https://….trycloudflare.com`
2. Project → Settings → Webhooks  
   - URL: `…/webhooks/gitlab`  
   - Secret = `GITLAB_WEBHOOK_SECRET`  
   - Trigger: **Issues events**

Quick tunnel URL đổi mỗi lần start — cập nhật lại webhook hoặc dùng named tunnel cố định.

## Luồng git (đã chốt)

- Giữ nhánh đang đứng (vd. `bugs/dangkhoa/ykk/some-bugs`) — **không** checkout `main`, **không** tạo `auto/*`
- Commit: `feat #<iid> <issue title>`
- Không stage/commit: `resources/js/composables/permission.js`, `resources/js/directives/index.js` (vẫn tracked local)
- Orchestrator push + mở MR; **không merge**

## Teams clarify

Khi agent emit `NEED_CLARIFICATION`: gửi câu hỏi vào chat 1:1 → poll reply → `Agent.resume` (tối đa `MAX_CLARIFY_ROUNDS`, timeout `TEAMS_CLARIFY_TIMEOUT_MIN`).

## Job state

- `data/jobs/*.json` — status queued/running/awaiting_clarification/succeeded/failed  
- Restart process: job đang chạy → đánh dấu **failed** (scan lại sẽ enqueue issue chưa succeeded)  
- Skip labels: `auto-work:skip`, `wip-human`

## Scripts npm

| Command | Mô tả |
|---------|--------|
| `npm run dev` | Chạy server |
| `npm run list-tasks` | List issue assigned |
| `npm run scan` | List + enqueue |
| `npm run selfcheck` | Unit check filter/prompt |
| `npm run typecheck` | `tsc --noEmit` |

## Bảo mật

- `.env` nằm trong `.gitignore` — **không commit** token/key  
- Commit chỉ `.env.example` (placeholder)
