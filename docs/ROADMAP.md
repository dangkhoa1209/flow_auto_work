# Next Sprint Roadmap

Đã ship gần đây:

1. Docs-first gate + feature docs (.md/.mdc) + AiHR rules khi code
2. Tasks group theo Milestone
3. **Multi-user / multi-project** — login GitLab username; PAT + Cursor key **encrypted**; join nhiều project; paste work branch

---

## Ưu tiên Sprint tiếp theo

### 1. Per-user git worktree — P0

Tránh conflict khi 2 dev cùng local repo path trên 1 máy.

### 2. Duyệt Plan trước khi Code — P1

Plan approval đầy đủ (file `.flow/plans/`, sửa step) vẫn backlog.

### 3. Terminal / CLI approval — P1

### 4. GitLab CI feedback loop — P1

### 5. QC Automation Extension — P0 (in progress)

Tách namespace `/api/qc` + role `qc`; Chrome MV3 Record/Playback; web `/qc` CRUD.

| Phase | Mục tiêu |
|-------|----------|
| 0 | Docs + `requireQc` + collections |
| 1 | MV3 message passing + `chrome.storage.session` |
| 2 | Record engine + save flows |
| 3 | Playback + navigation resume + flow chaining |
| 4 | Faker/loop, web CRUD, sample file upload |

Chi tiết: [QC_PRD.md](./QC_PRD.md) · [QC_ARCHITECTURE.md](./QC_ARCHITECTURE.md).
