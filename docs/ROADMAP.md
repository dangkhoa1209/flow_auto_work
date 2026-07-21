# Next Sprint Roadmap

Đã ship gần đây:

1. **Clean Context** — lọc comment nhiễu trước prompt
2. **Force Stop** — kill job + `run.cancel()`
3. **Done = awaiting_handoff** — không push/MR; không auto assign
4. **Handoff UI + Thống kê theo ngày**
5. **Progress stream** Cursor · dark UI · nodemon · loading fetch
6. Comment chỉ khi xong (`Task work 100% by AI` + summary VI); handoff **add** labels only

---

## Ưu tiên Sprint tiếp theo

### 1. Duyệt Plan trước khi Code — P0

- Phase 1: agent chỉ viết plan → file `.flow/plans/#<iid>.md` + UI.
- User sửa step / Approve Plan.
- Phase 2: agent thực thi theo plan đã chốt.
- Status: `awaiting_plan_approval`.

### 2. Terminal / CLI approval — P1

- Agent đề xuất lệnh (whitelist).
- UI Allow / Deny; log chat.

### 3. GitLab CI feedback loop — P1

- Pipeline fail trên branch job → enqueue “Fix CI”.

### 4. Outbound notify — P2

- Webhook khi `awaiting_handoff` / `succeeded` / `failed`.

---

```
Plan approval → Notify → CI feedback → CLI popup
```
