# Flow Auto WorkBench — Web UI (Vue 3)

Vue 3 + Ant Design Vue + Tailwind + Pinia + Vue Router.

## Dev

Terminal 1 (API):
```bash
npm run dev
```

Terminal 2 (UI):
```bash
npm run dev:web
```

Open http://127.0.0.1:5173/ (proxies `/api` → `:8787`).

## Production build

```bash
npm run build:web
npm start
```

Server serves `apps/web/dist` when present; otherwise falls back to legacy `public/index.html`.

## Routes

| Path | Purpose |
|------|---------|
| `/work` | Tasks / jobs / chat / progress |
| `/handoff` | QC handoff |
| `/stats` | Daily stats |
| `/settings/project` | Project + branches |
| `/settings/cursor` | Cursor key / model |
| `/settings/labels` | Processing + handoff prefs |
| `/settings/account` | Account / logout |
