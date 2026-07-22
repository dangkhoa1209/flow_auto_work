# Flow Auto Work

Orchestrator **local**: GitLab issues → UI Start → Cursor SDK trên `aihr_v3` → commit local → **`awaiting_handoff`** → user assign/labels → `succeeded`.

> Chi tiết: [`docs/NOTES.md`](docs/NOTES.md) · Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Tính năng chính

| Phần | Chi tiết |
|------|----------|
| UI | Dark theme · Work / Done chờ / Thống kê · loading trên fetch |
| Jobs | Queue serial; Force Stop; tiến trình Cursor live |
| Done | 1 task = 1 job; Dev Notes trên job; Run / Run tất cả; re-run cùng job |
| Handoff | Assign + **add** labels (không xóa label cũ) → `succeeded` |
| Comment | Chỉ khi xong: `Task work 100% by AI` + summary tiếng Việt |
| Git | Giữ branch hiện tại; `feat #<iid> <title>` |
| Dev | `npm run dev` + `npm run dev:web` |
| Mongo | `jobs` + `notes` + `chat` |
| Boot | UI Vue (web/) · fallback public/ nếu chưa build |
| FE | Vue 3 + Ant Design Vue + Tailwind · Settings tách route |

## Luồng

```
UI Start → JobQueue → Cursor agent (+ clarify UI)
                ↓ DONE
         commit local (nếu cần)
                ↓
         awaiting_handoff + comment GitLab
                ↓
         UI Done chờ (assign / add labels)
                ↓
            succeeded
```

## Chạy

```bash
cp .env.example .env   # điền secrets
npm install
npm install --prefix web
npm run build:web      # build Vue → web/dist
npm run dev            # API :8787 (serve web/dist)
# Dev UI hot-reload:
#   npm run dev:web    → http://127.0.0.1:5173/ (proxy /api)
```

| Command | Mô tả |
|---------|--------|
| `npm run dev` | Nodemon + server |
| `npm run dev:web` | Vite UI (proxy API) |
| `npm run build:web` | Build Vue → `web/dist` |
| `npm start` | Chạy một lần (không watch) |
| `npm run typecheck` | `tsc --noEmit` |

## Job status

`queued` → `running` → (`awaiting_clarification`) → `awaiting_handoff` → `succeeded`  
(hoặc `failed`)

## Bảo mật

- `.env` trong `.gitignore` — không commit token/key  
- Chỉ commit `.env.example` (placeholder)
