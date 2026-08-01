# Mẫu lên task chuẩn "Good Context" — dành cho PD

> Task viết đủ ngữ cảnh sẽ được Workbench chấm **Good Context** → AI agent code
> thẳng, không hỏi lại, không bị chặn. Task mù mờ bị chấm **Bad** → nút Run bị
> khóa cho tới khi bổ sung thông tin.

## Quy tắc 3 dòng (nhớ mỗi cái này cũng được)

Một task đạt Good khi có đủ **3 nhóm thông tin**:

1. **Ở đâu** — route/URL màn hình, API, hoặc tên file/màn hình liên quan
2. **Làm gì** — Feature: Input → Output; Bug: các bước tái hiện + đang xảy ra gì vs mong đợi gì
3. **Bằng chứng** — text trên UI (để trong ngoặc kép), tên field, error log nếu có

Thiếu cả 3 → Bad. Có 1–2 mỏ neo (text UI, tên field, API) → Searchable (agent
phải tự tìm file, chậm hơn). Đủ 3 → Good.

---

## Template trống (copy vào description khi tạo issue)

```markdown
## Mục tiêu (1–2 câu)

<!-- Làm gì, cho ai, để giải quyết vấn đề gì -->

## Loại

- [ ] Feature
- [ ] Bug

## Vị trí trong app (bắt buộc — ít nhất 1 dòng)

- Route/URL màn hình: `/admin/...`
- API liên quan: `GET|POST /api/...`
- File / Component / Model đã biết (hỏi dev nếu không rõ): ...

## Nếu là Bug

- Steps to reproduce:
  1. ...
  2. ...
- Current behavior (đang xảy ra): ...
- Expected behavior (mong đợi): ...
- Error log / screenshot console (nếu có): ...

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

## Ví dụ 1 — FEATURE điền sẵn (đạt Good)

```markdown
## Mục tiêu (1–2 câu)

Cho phép C&B gia hạn hợp đồng hàng loạt: chọn nhiều nhân viên sắp hết hạn hợp
đồng rồi bấm một nút để tạo hợp đồng mới theo "loại kế tiếp".

## Loại

- [x] Feature

## Vị trí trong app

- Route/URL màn hình: `/admin/contracts/expiring`
- API liên quan: `POST /api/contracts/bulk-renew`
- File / Component / Model đã biết: `ContractExpiringList.vue`, `ContractService.php`, collection `contracts`

## Nếu là Feature

- Input: danh sách `employee_code` được tick chọn + ngày hiệu lực (mặc định =
  ngày hết hạn cũ + 1)
- Output: mỗi nhân viên được tạo 1 bản ghi hợp đồng mới, loại lấy theo bảng
  "loại kế tiếp" (Thử việc → 1 năm → 3 năm → Vô thời hạn); toast hiển thị
  "Đã gia hạn N hợp đồng"
- Ràng buộc: nhân viên đã nghỉ việc thì bỏ qua và liệt kê ở popup kết quả;
  không tạo trùng nếu đã có hợp đồng mới chồng thời gian

## Phạm vi & ngoài phạm vi

- Trong phạm vi: màn hình danh sách sắp hết hạn + API bulk-renew
- KHÔNG đụng tới: luồng ký số, template in hợp đồng

## Acceptance criteria

- [ ] Chọn 3 NV → bấm "Gia hạn hàng loạt" → 3 hợp đồng mới đúng loại kế tiếp
- [ ] NV nghỉ việc trong danh sách chọn → bị bỏ qua + hiện trong popup kết quả
- [ ] Không tạo bản ghi trùng khi bấm nút 2 lần liên tiếp
```

Vì sao đạt Good: có route + API + file/model (**ở đâu**), Input/Output rõ
(**làm gì**), tên field `employee_code`, text nút `"Gia hạn hàng loạt"`
(**bằng chứng**).

---

## Ví dụ 2 — BUG điền sẵn (đạt Good)

```markdown
## Mục tiêu (1–2 câu)

Sửa lỗi màn chấm công không hiển thị giờ check-out của ca đêm (qua ngày).

## Loại

- [x] Bug

## Vị trí trong app

- Route/URL màn hình: `/admin/attendance/daily`
- API liên quan: `GET /api/attendance/daily?date=...`
- File / Component / Model đã biết: `AttendanceDailyTable.vue`, collection `attendances`

## Nếu là Bug

- Steps to reproduce:
  1. Nhân viên có ca đêm 22:00 → 06:00 sáng hôm sau (vd. mã NV `EMP0012`, ngày 15/07)
  2. Mở `/admin/attendance/daily`, chọn ngày 15/07
  3. Nhìn cột "Giờ ra"
- Current behavior (đang xảy ra): cột "Giờ ra" trống, dù app mobile đã ghi
  nhận `check_out` lúc 06:02 ngày 16/07
- Expected behavior (mong đợi): hiển thị `06:02 (+1)` — giờ ra kèm dấu qua ngày
- Error log: console không có lỗi; response API ngày 15/07 thiếu field
  `check_out` cho ca đêm (nghi lọc theo ngày sai múi giờ)

## Phạm vi & ngoài phạm vi

- Trong phạm vi: hiển thị + query giờ ra ca đêm
- KHÔNG đụng tới: logic tính công / tính lương OT

## Acceptance criteria

- [ ] Ca đêm 22:00–06:00 hiển thị "Giờ ra" là `06:02 (+1)` ở ngày bắt đầu ca
- [ ] Ca ngày bình thường không bị ảnh hưởng
```

Vì sao đạt Good: có steps to reproduce + current vs expected (**bug triad**),
kèm route, file, field `check_in`/`check_out` để agent bám vào.

---

## Đối chiếu: task kiểu này sẽ bị chặn (Bad Context)

| Viết thế này (Bad) | Sửa lại tối thiểu để chạy được |
|---|---|
| "Sửa bug chấm công" | Thêm route `/admin/attendance/daily` + 3 bước tái hiện + đang thấy gì vs mong đợi gì |
| "Làm cho dashboard nhanh hơn" | Chỉ rõ màn nào (`/admin/dashboard`), thao tác nào chậm, chậm bao nhiêu giây, mong đợi bao nhiêu |
| "Thêm export Excel giống bên kia" | Ghi rõ export ở màn nào, cột nào, nút đặt ở đâu, "bên kia" là màn nào |
| "App bị trắng màn" | Bước tái hiện + máy/trình duyệt + screenshot console (F12 → Console, chụp lỗi đỏ) |

## Mẹo nhanh cho PD

- **Không biết tên file?** Không sao — điền route/URL + text trên nút/label
  trong ngoặc kép (vd. `"Lưu thay đổi"`) là agent tự tìm được. Hỏi dev 1 câu
  "màn này là file nào" thì càng tốt.
- **Log lỗi nguyên văn > mô tả lại bằng lời.** Bug trên web: F12 → tab Console,
  copy nguyên khối chữ đỏ dán vào ticket.
- **Mô tả ≥ 20 từ.** Dưới ngưỡng này hệ thống tự chấm Bad bất kể nội dung.
- Tránh các từ đứng một mình: "sửa", "fix", "cải thiện", "giống bên kia",
  "sao cũng được" — phải kèm vị trí + hành vi cụ thể.
- Mỗi ticket một việc. "Sửa 5 lỗi màn nhân viên" → tách 5 ticket.
