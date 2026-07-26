# GitLab Issue Template — chuẩn "Good Context"

Copy file này vào repo dự án (repo được agent code, vd. AiHR) tại:

```
.gitlab/issue_templates/AI-Ready.md
```

Khi tạo issue trên GitLab, chọn template **AI-Ready** ở dropdown "Description".
Issue viết theo template này sẽ được Flow Workbench chấm **Good Context** →
agent code thẳng, không tốn vòng hỏi lại / không bị chặn Bad Context.

Tiêu chí chấm điểm (xem `src/plugins/agent/context-quality.ts`):

- **Good** — Feature: route/URL + Input/Output + Model/Component. Bug: steps to
  reproduce + current vs expected + error log. Hoặc Dev Notes ≥ ~25 từ có tín
  hiệu kỹ thuật.
- **Searchable** — có mỏ neo (UI text, field, API path) nhưng chưa chỉ file →
  agent phải grep trước.
- **Bad** — mô tả < 20 từ hoặc toàn từ chung chung ("sửa bug", "chạy chậm") →
  Run bị chặn, không gọi agent.

---

## Template (copy phần dưới vào `.gitlab/issue_templates/AI-Ready.md`)

```markdown
## Mục tiêu (1–2 câu)

<!-- Làm gì, cho ai. VD: Cho phép C&B gia hạn hợp đồng hàng loạt theo loại kế tiếp. -->

## Loại

- [ ] Feature
- [ ] Bug
- [ ] Refactor / tech debt

## Vị trí trong app (bắt buộc — ít nhất 1 dòng)

- Route/URL màn hình: `/admin/...`
- API liên quan: `GET|POST /api/...`
- File / Component / Model đã biết: `EmployeeList.vue`, `ContractService.php`, collection `contracts`

## Nếu là Bug

- Steps to reproduce:
  1. ...
  2. ...
- Current behavior (đang xảy ra): ...
- Expected behavior (mong đợi): ...
- Error log / stack trace (nếu có):

  ```
  (paste log)
  ```

## Nếu là Feature

- Input (user nhập gì / API nhận gì): ...
- Output (hiển thị gì / API trả gì): ...
- Ràng buộc / quy tắc nghiệp vụ: ...

## Phạm vi & ngoài phạm vi

- Trong phạm vi: ...
- KHÔNG đụng tới: ...

## Acceptance criteria

- [ ] ...
- [ ] ...
```

---

## Mẹo cho PM/Dev

- Điền được **route + 1 file/model + input/output** là gần như chắc chắn Good.
- Log lỗi nguyên văn (stack trace) đáng giá hơn mô tả lại bằng lời.
- Text trên UI để trong ngoặc kép (`"Lưu thay đổi"`) — agent dùng làm mỏ neo grep.
- Nếu không rõ file, ghi tên field / tên collection cũng đủ mức Searchable.
