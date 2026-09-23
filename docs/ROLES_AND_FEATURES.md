# Roles & features — hiện trạng Flow Auto WorkBench

Tài liệu mô tả **capability roles**, **3 trụ sản phẩm** (Code · ChatBox · Build), **console Admin**, và các tính năng nhỏ theo code hiện tại.

Neo chính:

- Roles / home / ACL: `apps/api/src/workspace/types.ts`
- Session UI gates: `apps/web/src/stores/session.ts`
- App switcher: `apps/web/src/components/layout/AppSwitcher.vue`
- Routes: `apps/web/src/router/index.ts`
- BA feature flags: `apps/api/src/workspace/baStore.ts` · UI `AdminBaFeaturesView.vue`

---

## 1. Roles (6)

| Role | Đăng ký? | Home path | Audience / ghi chú |
|------|----------|-----------|-------------------|
| **Dev** | Có | `/dev` | WorkBench AI coding; switcher Code + ChatBox + QC + Build (chạy script) |
| **BA** | Có | `/ba` | Project Chat (audience BA) |
| **PD** | Có | `/ba` | Cùng audience BA với role `ba` |
| **QC** | Có | `/qc` | Project Chat QC + Create Data; extension Record/Play (role `qc`) |
| **Devops** | Có | `/devops` | Build console (cấu hình + chạy); cũng vào ChatBox `/ba` |
| **Admin** | **Không** (seed-only) | `/admin` | Quản trị hệ thống; có thể vào Code / ChatBox / QC / Build theo ACL |

### Quy ước đăng ký & gán role

- `REGISTERABLE_ROLES` = `dev | qc | pd | ba | devops` — chọn lúc đăng ký.
- `admin` **không** chọn lúc register; tạo qua seed (`ROOT_ADMIN_USERNAME = "admin"`) hoặc admin gán role.
- `ALL_USER_ROLES` = cả 6 — admin có thể gán bất kỳ role nào (một role / user trên UI quản trị hiện tại).
- Account không có roles → legacy normalize thành `["dev"]`.
- Root admin (`admin`) được bảo vệ: không disable / không xóa / không đổi role qua Admin Users.

### Audience helpers (quan trọng khi đọc code)

| Helper | Ý nghĩa |
|--------|---------|
| `isBaAudience` | Chỉ `ba` hoặc `pd` (không phải admin/dev/devops) → home `/ba` |
| `isQcAudience` | Chỉ `qc` (không admin/dev/devops) → home `/qc` |
| `isDevopsAudience` | Có `devops`, không `admin`, không `dev` → home `/devops` |
| `primaryHomePath` | admin → `/admin` → dev → `/dev` → devops → `/devops` → qc → `/qc` → ba/pd → `/ba` |

Admin / Dev / Devops **không** bị coi là “audience BA/QC thuần”, nhưng vẫn **được vào** `/ba` và `/qc` (cùng API project chat) để hỗ trợ / kiểm thử.

### Quyền truy cập theo surface (API + UI)

| Capability | Roles được phép |
|------------|-----------------|
| Work / Code (`/dev`, jobs, tasks GitLab) | `admin`, `dev` |
| BA Chat UI (`/ba`) | `ba`, `pd`, `admin`, `dev`, `devops` |
| QC Chat UI (`/qc`) | `qc`, `admin`, `dev`, `devops` |
| Project chat API (`/api/ba`) | BA hoặc QC surface ở trên |
| Build console xem/chạy (`/devops`) | `admin`, `devops`, `dev` |
| Cấu hình build scripts (CRUD) | `admin`, `devops` (**không** plain `dev`) |
| Admin API / UI (`/admin`, `/api/admin`) | `admin` only |

App switcher (desktop) hiện tối đa 4 nút khi role đủ quyền: **Code · ChatBox · QC · Build**. Admin shell có shortcut riêng sang ChatBox / QC / Build (không dùng cùng AppSwitcher segment).

---

## 2. Ba trụ sản phẩm + Admin

UI product framing:

1. **Code** — WorkBench AI coding (`/dev`)
2. **ChatBox** — Project chat (`/ba`; QC dùng shell `/qc`)
3. **Build** — DevOps scripts (`/devops`)

**Admin** không phải trụ thứ 4 trên App switcher; là **console quản trị** (`/admin`) điều khiển users, catalog ChatBox, AI Engine, feature flags, Sync DB, …

Đếm nhanh tính năng nhỏ (hiện trạng):

| Trụ / khối | ~Số nhỏ | Ghi chú |
|------------|---------|---------|
| Code | ~8 | Jobs, context gate, docs-first, handoff, … |
| ChatBox (+ QC shell + extension) | ~9–10 | Flags hide/lab/production; chat luôn bật |
| Build | ~4 | Scripts + queue + log |
| Admin | ~7 | Users, Usage, Chatbox catalog, AI Engine, Task labels, BA features, Sync DB |
| **Tổng** | **~28–29** | Admin tách khỏi 3 trụ; không tính settings account chung |

---

## 3. Code — WorkBench (`/dev`)

**Ai dùng:** Dev + Admin.

**Layout:** Work · Handoff · Stats · Settings (project / integrations / account).

### 3.1 Tính năng nhỏ

1. **Tasks GitLab** — issue assign cho user; filter Milestone; mở theo `#iid`; preview Related/child (không mở job).
2. **Hotfix** — job ad-hoc không gắn issue; reuse work branch nếu đã cấu hình.
3. **Job queue** — serial Run / Run all; Force Stop; Reset window; đổi status / xóa job.
4. **Agent chat** — MISSION prompt + Cursor SDK; clarify loop trên UI; progress live (SSE `/api/events`).
5. **Context quality gate** — `good` / `searchable` / `bad`; bad → chặn agent; UI tag + modal tiêu chuẩn.
6. **Docs-first** — phase docs → `awaiting_docs_approval` → Approve rồi mới code.
7. **Commit + follow-up** — commit qua GitLab API (author = PAT); sync local; follow-up chat trên job Done (không đổi code → giữ status).
8. **Handoff** — `awaiting_handoff` → assign + add/remove labels (± merge work → base) → `succeeded`; prefs theo user+project.
9. **Stats + Settings** — thống kê jobs; project path, base/work branch, PAT, Cursor PATs/model, labels on-start / processing, milestones, verify command, commit mode.

### 3.2 Job status (hiện trạng)

```
draft → queued → running
  → (awaiting_clarification | awaiting_docs_approval)
  → awaiting_handoff → succeeded
  (hoặc failed)
```

Chi tiết pipeline / SSE / context: [NOTES.md](./NOTES.md) · overview nhanh: [README.md](../README.md).

---

## 4. ChatBox — Project chat (`/ba` · `/qc`)

**Ai dùng (UI):**

| Path | Primary audience | Cũng vào được |
|------|------------------|---------------|
| `/ba` | BA, PD | Admin, Dev, Devops |
| `/qc` | QC | Admin, Dev, Devops |

QC reuse layout/views BA (`BaLayout`, `BaChatView`, …) với `meta.requiresQc`. API chung `/api/ba` cho đến khi tool QC tách hết.

### 4.1 Feature flags (Admin)

Trạng thái từng flag: **`hide` | `lab` | `production`**.

| Key | UI | Mô tả |
|-----|-----|--------|
| *(luôn bật)* | Chat + BA mode | Thread chat + agent — **không** nằm trong flags |
| `createIssue` | Create issue | Tạo GitLab issue từ chat |
| `workflow` | Requirements analysis (label đổi được) | Tab phân tích YC: source → clarify → hiện trạng → đề xuất → tasks |
| `tasks` | Tasks | Draft tasks → publish GitLab |
| `syncDatabase` | Sync Database | Dump live Mongo → restore Connect DB (cần cấu hình Sync DB hệ thống) |
| `createData` | Create Data | Seed test data (plan → preview → write); không nhắm production |

- Mặc định khi chưa cấu hình: flags → **hide** (chỉ chat mở).
- **Dev mode** (`DEV=true` hoặc `PRODUCTION=false`): mọi flag hiệu lực = `production`.
- Admin có thể đổi `workflowTabLabel` (mặc định code: `"Phân tích YC"` / UI admin “Requirements”).

### 4.2 Tính năng nhỏ (ChatBox + QC)

1. **Chatbox threads + agent** — luôn bật; SSE / agent BA.
2. **Create issue từ chat** — flag `createIssue`.
3. **Phân tích YC / Workflow** — flag `workflow`; route `/ba/workflow` (và `/qc/workflow`).
4. **Tasks drafts → GitLab** — flag `tasks`; `/ba/tasks`.
5. **Sync Database** — flag `syncDatabase`; phụ thuộc Admin Sync DB + Connect DB project.
6. **Create Data** — flag `createData`; `/ba/create-data` · `/qc/create-data`; catalog/scenario + knowledge (admin chỉnh per BA project).
7. **Settings** — Git PAT, Google OAuth (Docs/Sheets), Account.
8. **QC web shell** — cùng tabs chat/workflow/tasks/create-data dưới `/qc`.
9. **QC Extension MV3** — Record & Playback, flows/test cases, Faker/loop (PRD); auth role `qc`, API `/api/qc/*`. Chi tiết: [QC_PRD.md](./QC_PRD.md) · [QC_ARCHITECTURE.md](./QC_ARCHITECTURE.md).

### 4.3 Catalog project ChatBox (Admin)

Admin → **Project Chatbox** (`/admin/chatbox`): CRUD BA projects (GitLab path, clone `project/_ba/<slug>/source`), Connect DB / Create Data DB test, create-data knowledge. Không phải tab end-user ChatBox.

---

## 5. Build — DevOps console (`/devops`)

**Ai dùng:**

| Hành động | Roles |
|-----------|--------|
| Xem / chạy script | `devops`, `dev`, `admin` |
| Tạo / sửa / xóa / bật-tắt script | `devops`, `admin` |

### 5.1 Tính năng nhỏ

1. **Danh sách & cấu hình scripts** — CRUD + active toggle (chỉ devops/admin).
2. **Chạy script** — Dev cũng Run được; confirm khi script đang queued/running.
3. **Hàng đợi build** — queue serial; feed trạng thái jobs.
4. **Terminal log / lịch sử** — output theo build job.

Settings devops hiện chủ yếu Account (`/devops/settings/account`).

Neo: `DevopsView.vue` · `canConfigureDevopsScripts` · middleware devops.

---

## 6. Admin — System console (`/admin`)

**Ai dùng:** chỉ role `admin`. Home mặc định sau login.

**Không** nằm trên App switcher Code/ChatBox/QC/Build; topbar Admin có shortcut sang ChatBox / QC / Build.

### 6.1 Tabs hiện trạng (`AdminLayout`)

| Path | Tính năng nhỏ | Việc làm |
|------|---------------|----------|
| `/admin/users` | **Users** | List / create / update role / disable / enable / delete / reset password; bảo vệ root `admin`; thống kê BA chat message/thread |
| `/admin/usage` | **Cursor Usage** | Theo dõi usage Cursor (filter theo API) |
| `/admin/chatbox` | **Project Chatbox catalog** | BA projects CRUD, clone status, test Connect DB / Create Data DB, create-data knowledge |
| `/admin/ai-engine` | **AI Engine** | System Cursor PATs (shared BA), active key, model list/update (`/admin/cursor` redirect) |
| `/admin/task-types` | **Task labels** | Mapping label GitLab theo loại task (bug/feature/refactor/chore) |
| `/admin/ba-features` | **BA features** | Flags hide/lab/production + workflow tab label + báo `devMode` |
| `/admin/sync-db` | **Sync DB** | Cấu hình SSH + source Mongo hệ thống cho Sync Database (encrypted) |
| `/admin/settings/account` | Account | Đổi mật khẩu / account settings |

### 6.2 Quyền chéo Admin trên 3 trụ

| Trụ | Admin được gì |
|-----|----------------|
| Code | Full WorkBench như Dev (`canAccessWork`) |
| ChatBox / QC | Vào `/ba` và `/qc`; bật/tắt flags; cấu hình catalog + Sync DB + AI Engine |
| Build | Chạy **và** cấu hình scripts như Devops |

---

## 7. Matrix role × surface

| Role | Code `/dev` | ChatBox `/ba` | QC `/qc` | Build `/devops` | Admin `/admin` |
|------|:-----------:|:-------------:|:--------:|:---------------:|:--------------:|
| Dev | ✓ | ✓ | ✓ | ✓ chạy (không CRUD script) | |
| BA | | ✓ | | | |
| PD | | ✓ | | | |
| QC | | | ✓ (+ Create Data / extension) | | |
| Devops | | ✓ | ✓ | ✓ cấu hình + chạy | |
| Admin | ✓ | ✓ | ✓ | ✓ cấu hình + chạy | ✓ |

Ghi chú:

- BA/PD không thấy Code / Build / Admin.
- QC không thấy Code / Build / Admin; Create Data phụ thuộc flag + Connect DB.
- Dev thấy QC shell trên switcher nếu `canAccessQc` (dev/admin/devops đều true) — dùng để hỗ trợ, không thay role QC extension auth (`requireQc` trên `/api/qc`).

---

## 8. Settings theo shell (không đếm vào 3 trụ)

Một layout động (`SettingsLayout.vue` + registry `config/settingsNav.ts`) — tabs ẩn/hiện theo shell; giữ prefix route riêng.

| Shell | Settings tabs |
|-------|----------------|
| Code (`/settings/*`) | Project, Integrations, AI Engine, Labels, Account |
| ChatBox / QC (`/ba|qc/settings/*`) | GitLab PAT, Google, Account |
| Build (`/devops/settings/*`) | Account |
| Admin (`/admin/settings/*`) | Account |

Auth session (access ~10m, refresh ~30d): [AUTH_SESSION.md](./AUTH_SESSION.md).

---

## 9. Stack & ranh giới (tóm tắt)

| Layer | Hiện trạng |
|-------|------------|
| Web | Vue 3 · Ant Design Vue · Tailwind · shells theo role |
| API | Express/Hono-style routes · Mongo · SSE |
| Agent Code | Cursor SDK local · context quality · GitLab/GitHub project forge |
| ChatBox agent | Cursor (system/user keys) · `code_map_query` (agent chọn locator, cùng quy tắc /dev) |
| QC | Web CRUD + Chrome MV3 extension · collections `qc_*` |
| Secrets | `FLOW_SECRETS_KEY` · PAT/Cursor/Google/Figma encrypted |

---

## 10. Giả định tài liệu này

1. **“3 tính năng lớn”** = Code · ChatBox · Build (App switcher product). **Admin** = console thứ tư về mặt quản trị, không đổi framing 3 trụ.
2. **QC** trên UI là shell ChatBox riêng + extension; không tách thành trụ App switcher thứ 5 ngoài nút **QC**.
3. Số “~8 / ~9 / ~4 / ~7” là gom nhóm chức năng user-facing hiện có — không phải đếm endpoint API.
4. Khi flags BA = hide, end-user chỉ thấy chat; admin/dev mode có thể override.

Cập nhật doc này khi đổi `REGISTERABLE_ROLES`, flags `BaFeatureKey`, tabs Admin, hoặc App switcher.
