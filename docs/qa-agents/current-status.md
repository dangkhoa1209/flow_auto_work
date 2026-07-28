# QA Agents — Hiện trạng module

> Cập nhật: 2026-07-29  
> Spec gốc: [`technical-spec.md`](./technical-spec.md)

## 1. Tổng quan

Module **QA Agents** tự động hóa tái hiện lỗi / E2E debug UI trên staging: login bypass JWT → Chromium headless (Chrome DevTools MCP) → capture console/network/screenshot → human review → tạo GitLab Issue.

Đây là **service + UI tách** khỏi coding WorkBench:

| Thành phần | Đường dẫn | Port mặc định |
|---|---|---|
| QA API | `qa-agents/` | `8788` (`QA_PORT`) |
| QA Web UI | `qa-web/` | Vite `5174` → proxy `/api` → `8788` |
| Coding API | `src/` | `8787` |
| Coding Web | `web/` | Vite `5173` |

**Boundary cứng:** QA không import `src/queue.ts` hay coding agent runner. Chỉ reuse GitLab client, workspace/auth/crypto, Cursor SDK pattern, logger, config DB.

---

## 2. Kiến trúc hiện tại

```text
qa-web (Vue)
   │  REST + SSE
   ▼
qa-agents Express
   ├── /api/auth, /api/me, /api/projects   (reuse Flow routes)
   ├── /api/qa/*                          (config, presets, jobs, meta)
   ├── /api/events                        (SSE riêng)
   └── QaJobQueue ──► login bypass ──► Cursor SDK + chrome-devtools-mcp
                              │
                              ▼
                    Mongo (jobs kind=qa, qa_project_configs, qa_account_presets)
                              │
                              ▼ (khi Duyệt)
                    GitLab upload + createIssue
```

### Reuse từ Flow (`src/`)

- Auth sessions / access token (`requireWorkspace`)
- Workspace users–projects–memberships–secrets
- `encryptSecret` / `decryptSecret`
- `createIssue`, `listProjectMembers`, `listProjectLabels`
- `@cursor/sdk` (`Agent.create` / `resume` / `send`)
- Mongo connection + collection `jobs` (filter `kind: "qa"`)

### Không reuse

- Coding `JobQueue` (`src/queue.ts`)
- `plugins/agent/run.ts`, verify/self-heal, git prep/commit

---

## 3. Cấu trúc mã nguồn

### Backend — `qa-agents/src/`

| File / thư mục | Vai trò |
|---|---|
| `index.ts` | Bootstrap Mongo, indexes, restore queue, listen |
| `app.ts` | Express app, mount auth/me/projects + `/api/qa` |
| `config.ts` | `QA_PORT` + share Flow config |
| `queue.ts` | `QaJobQueue` — lane theo `workspaceProjectId` |
| `job-store.ts` | CRUD job `kind=qa`, artifacts, progress SSE |
| `store.ts` | Config project + account presets (password mã hóa) |
| `realtime/hub.ts` | Pub/sub SSE riêng QA |
| `modules/qa/` | Business: trigger, adjust, approve, meta |
| `plugins/login/` | HTTP login bypass + JSON path token |
| `plugins/agent/` | Prompt ReAct + Cursor/MCP runner |
| `plugins/issue/markdown.ts` | Template Issue cứng (spec) |
| `plugins/gitlab/upload.ts` | `POST /uploads` screenshot |
| `plugins/fs/cleanup.ts` | Xóa artifact cũ (TTL 7 ngày) |
| `__tests__/qa-core.test.ts` | Unit: parse outcome, markdown, mask secrets |

### Frontend — `qa-web/src/`

| View / module | Vai trò |
|---|---|
| `views/LoginView.vue` | Form Sign in/Register (style giống coding WorkBench) |
| `views/ConfigView.vue` | Staging URL, login convention, limits, presets |
| `views/TriggerView.vue` | Tạo job: URL + preset + testcase |
| `views/ReviewView.vue` | SSE progress, capture, Điều chỉnh / Duyệt / Kill |
| `stores/auth.ts` + `session.ts` | Token + project; gate `session.ready` trước khi gọi `/api/qa` |
| `api/http.ts` | Axios: `Authorization` + `X-Flow-User` + `X-Flow-Project` |

---

## 4. Model dữ liệu

### Job (`jobs`, `kind: "qa"`)

Status QA:

- `queued` → `running` → `awaiting_qa_review` | `needs_human_intervention` → `succeeded` | `failed`

Payload `job.qa` (`QaRunState`):

- `targetUrl`, `presetId`, `presetRole`, `testcase`
- `actionLog`, `consoleErrors`, `networkFailures`
- `screenshotPaths` (disk `qa-agents/artifacts/{jobId}/`)
- `draftMarkdown`, `draftTitle`
- `createdIssueIid`, `createdIssueUrl`, `adjustNotes`

Coding UI/queue **loại trừ** `kind === "qa"`.

### Config / presets (Mongo riêng)

- `qa_project_configs` — per `workspaceProjectId`
- `qa_account_presets` — username + `passwordEnc` (AES-GCM)

Convention login mặc định:

```ts
{
  stagingBaseUrl: string;
  loginPath: "/api/v1/auth/login";
  requestBodyKeys: { username: "username"; password: "password" };
  tokenJsonPath: "data.accessToken";
  localStorageTokenKey: "accessToken";
  maxActions: 10;
  actionTimeoutSec: 30;
  maxConcurrentSessions: 1;
}
```

---

## 5. API bề mặt

Base: `http://127.0.0.1:8788` (hoặc proxy qua `5174`).

Auth: Bearer access token + header `X-Flow-Project` (trừ `/api/auth/*`, `/api/me`, `/api/projects/*`).

| Method | Path | Mô tả |
|---|---|---|
| GET/PUT | `/api/qa/config` | Đọc/ghi config staging + limits |
| GET/POST | `/api/qa/presets` | List / tạo preset |
| PATCH/DELETE | `/api/qa/presets/:id` | Sửa / xoá |
| GET/POST | `/api/qa/jobs` | List / tạo & enqueue |
| GET | `/api/qa/jobs/:id` | Chi tiết |
| POST | `/api/qa/jobs/:id/adjust` | Note → agent chạy tiếp |
| POST | `/api/qa/jobs/:id/approve` | Upload screenshot + `createIssue` |
| POST | `/api/qa/jobs/:id/kill` | Hủy job |
| GET | `/api/qa/meta` | Members / labels / milestones |
| GET | `/api/qa/artifacts/:jobId/:file` | Screenshot tạm |
| GET | `/api/events` | SSE realtime |

---

## 6. Luồng runtime (MVP đã implement)

1. **Config** — staging URL, login fields, presets (UI Config)
2. **Trigger** — chọn project + preset + URL + testcase → `POST /api/qa/jobs`
3. **Queue** — API login bypass → JWT → Cursor agent + MCP headless
4. **Agent** — inject `localStorage`, navigate, ReAct (AXTree), capture, marker `<<<QA_DONE>>>` / `<<<QA_NEED_HELP>>>`
5. **Review** — SSE progress; Điều chỉnh (continue) hoặc Duyệt (assignee/milestone/labels)
6. **GitLab** — upload screenshot → Issue markdown template cứng → job `succeeded` (dừng, không enqueue coding)

---

## 7. Scripts chạy

```bash
# Backend QA
npm run start:qa          # hoặc: npm run dev:qa

# Frontend QA
npm run install:qa-web
npm run dev:qa-web        # http://127.0.0.1:5174

# Unit tests QA
npm run test:qa
```

Yêu cầu môi trường:

- Cùng `.env` Flow: `DB_*`, `FLOW_SECRETS_KEY`, `GITLAB_BASE_URL`
- `QA_PORT=8788` (optional)
- Node **≥ 22.12** khuyến nghị cho `chrome-devtools-mcp` (`qa-agents/package.json` engines)
- User workspace: Cursor API key + GitLab PAT project (như coding agent)

---

## 8. Quyết định đã khóa (đang áp dụng)

| Hạng mục | Giá trị |
|---|---|
| Hình thái | Service/UI tách, share GitLab/workspace |
| LLM | 1 `cursorModel` (không dual-model) |
| Browser | `chrome-devtools-mcp` headless, cùng máy server |
| Auth target | JWT → `localStorage` |
| Kết thúc | Tạo Issue → dừng |
| Review | Bắt buộc trước create Issue |
| Jobs | Cùng collection `jobs`, `kind: "qa"` |
| Realtime | SSE riêng trong QA service |
| Presets | Mongo + encryptSecret |
| Screenshot | Disk tạm → GitLab upload khi Duyệt |

---

## 9. Chưa làm / Out of MVP

- Source map resolution (stack minified → source gốc)
- Dual-model / prompt caching provider-level
- Auto-enqueue coding agent sau khi tạo Issue
- OAuth GitLab riêng (đang dùng PAT project)
- Package UI login shared thật sự (hiện port style/API, chưa monorepo package)
- Demo E2E staging thật phụ thuộc config + account người dùng

---

## 10. Rủi ro vận hành đã biết

- Gọi `/api/qa/*` **không** kèm Bearer + `X-Flow-Project` → `401 unauthorized` (mở URL trên thanh địa chỉ cũng fail)
- UI phải `session.ready` (đã có gate bootstrap + chọn project)
- Resume Cursor agent phải truyền lại `mcpServers`
- Artifact screenshot nằm local; cleanup TTL 7 ngày
