# Deploy / chạy production

Orchestrator **local**: Cursor SDK chạy trên repo máy host — không deploy “server thuần” kiểu PaaS nếu máy đó không có local repo + quyền git + Cursor SDK.

Setup nhanh / thử sau pull: [README.md](../README.md).

## Yêu cầu

- Node.js ≥ 20
- MongoDB (mặc định `127.0.0.1:27017`)
- Máy host có path local repo (agent `cwd`) và dùng được Cursor SDK
- Secrets: `FLOW_SECRETS_KEY`; login **username/password** (seed `khoadev`); GitLab PAT gắn **project**; Cursor key trên user
- **GitLab PAT** (project) cần scope **`api`** + write repo — clone + Commits API
- Optional: `AUTH_BYPASS_PASSWORD`, `PROJECT_ROOT` (default `<cwd>/project`)

## Các bước

### 1. Clone & env

```bash
cp .env.example .env
```

| Biến | Bắt buộc | Ghi chú |
|------|----------|---------|
| `FLOW_SECRETS_KEY` | Có | `openssl rand -hex 32` — ký JWT + mã hóa PAT/key |
| `PORT` / `HOST` | Không | Mặc định `8787` / `127.0.0.1` |
| `DB_HOST` / `DB_PORT` / `DB_DATABASE` | Không | Mongo |
| `DB_USERNAME` / `DB_PASSWORD` | Không | Nếu Mongo có auth |
| `GITLAB_BASE_URL` | Không | VD `https://gitlab.com` |

Không commit `.env`. Chỉ commit `.env.example`.

### 2. Cài & build UI

```bash
# Node ≥ 20 (khuyến nghị 20 LTS hoặc 22)
node -v

npm install                 # backend
npm install --prefix web    # frontend (bắt buộc — thiếu sẽ treo/lỗi ở vite build)
npm run build:web           # Vue → web/dist (server serve static)
```

Nếu `npm run build:web` dừng ở dòng `vite build` không ra thêm log:

1. Ctrl+C, chắc chắn đã `npm install --prefix web`
2. Thử verbose: `cd web && npx vite build --debug`
3. Máy ít CPU/RAM: `NODE_OPTIONS=--max-old-space-size=4096 npm run build:web`
4. Repo này dùng **Vite 6** (tránh hang Rolldown/Vite 8 trên Linux server)

### 3. Chạy

```bash
npm start            # production (tsx, không watch)
# hoặc
npm run dev          # nodemon + reload API
```

Mở **http://127.0.0.1:8787** (hoặc `HOST`/`PORT` trong `.env`).

| Command | Mô tả |
|---------|--------|
| `npm start` | API + serve `web/dist` |
| `npm run dev` | API watch |
| `npm run build:web` | Build UI trước khi dùng `:8787` sau khi sửa `web/src` |
| `npm run tunnel` | Cloudflare tunnel → `http://127.0.0.1:8787` |

### 4. Onboarding sau khi lên

1. Login (GitLab PAT + Cursor API key)
2. Settings → chọn project + **local repo path** + base / work branch
3. DevTools → Network: 1 EventStream `/api/events`
4. Run thử 1 task nhỏ

Auth: access ~10 phút, refresh ~30 ngày (Mongo). F5 / restart server: UI tự refresh access nếu còn refresh token.

## Reverse proxy (nginx / Caddy)

SSE `/api/events` cần **tắt buffer**, giữ connection dài. Ví dụ nginx:

```nginx
location /api/events {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 24h;
}

location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Caddy: `flush_interval -1` (hoặc tương đương) cho path SSE.

## Expose tạm (tunnel)

```bash
npm run tunnel       # cần cloudflared trên PATH
```

Phù hợp demo / truy cập từ máy khác; vẫn chạy agent trên máy host tunnel.

## Giới hạn deploy

- Sau Run: commit lên GitLab qua API (PAT); sync local. Merge work→base vẫn local git + push target; không auto MR.
- Job queue **serial** trên process hiện tại.
- Multi-user OK (Mongo + secrets mã hóa), nhưng mỗi Run vẫn cần path repo trên máy chạy server (Cursor SDK).
