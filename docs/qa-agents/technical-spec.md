# TECHNICAL SPEC: QA AGENT MODULE FOR BUG TRIAGING

## 1. Mục tiêu hệ thống

Xây dựng module **QA Agent** nhằm tự động hóa quá trình kiểm thử, tái hiện lỗi từ mô tả của QA/QC. Module này sử dụng **Chrome DevTools MCP** để điều hướng trình duyệt ngầm, bắt log hệ thống, trích xuất **Technical Stack Trace** (kết hợp với Source Maps) và tự động tạo **GitLab Issue** chuẩn hóa cho Developer.

---

## 2. Kiến trúc & Thành phần Hệ thống

- **QA Agent Frontend (Web App):** Giao diện cấu hình dự án, form tạo yêu cầu test, và màn hình Review kết quả realtime.
- **QA Agent Service (Backend):** Quản lý luồng chạy, xử lý API Login, gọi DevTools MCP, và tương tác với GitLab API.
- **LLM Engine (Dual-Model Setup):** Bộ não điều khiển Agent (kết hợp giữa Lightweight Model và Capable Model để tối ưu chi phí).
- **Chrome DevTools MCP Server:** Môi trường Chromium Headless ngầm lắng nghe lệnh qua Chrome DevTools Protocol (CDP).
- **GitLab Platform:** Hệ thống quản lý repository, nhận Issue được push từ QA Agent.

---

## 3. Chi tiết Luồng Tác vụ (End-to-End Workflow)

```
[Phase 1: Config] ──> [Phase 2: Trigger & Auth] ──> [Phase 3: MCP & Stack Trace] ──> [Phase 4: Review] ──> [Phase 5: Sync GitLab]
```

### Phase 1: Cấu hình Dự án (Project Onboarding)

- **1.1. GitLab Auth:** User kết nối tài khoản GitLab (lưu `Personal Access Token` hoặc `OAuth Token`).
- **1.2. API Login Config:** Khai báo Endpoint Login (`POST /api/v1/auth/login`), cấu trúc Request Body, và đường dẫn lấy JWT Token trong Response (ví dụ: `data.accessToken`).
- **1.3. Test Account Presets:** Lưu trữ danh sách Credential thử nghiệm (`Admin`, `User`, `VIP`) trên DB của Web App.

### Phase 2: Khởi tạo Yêu cầu & Bypass Login

- **2.1. QA Input:** QA chọn Project, chọn **Account Preset**, nhập **URL bị lỗi**, và nhập **Mô tả lỗi / Testcase**.
- **2.2. Fast API Login:** Backend lấy Credential từ Preset, gửi HTTP Request trực tiếp đến Endpoint Login của Staging.
- **2.3. Token Extraction:** Backend nhận JWT Token trả về (thời gian xử lý < 300ms).

### Phase 3: Thực thi Ngầm & Bắt Technical Stack Trace (Core Execution)

- **3.1. Session Injection:** Backend khởi chạy Chrome DevTools MCP (Headless Chromium), cấy JWT Token vào `localStorage` / `Cookie` của Browser Context trước khi nạp trang.
- **3.2. Direct Navigation:** Chromium mở thẳng URL bị lỗi dưới trạng thái đã đăng nhập.
- **3.3. Action Execution:** MCP thực hiện các thao tác (click, fill form) dựa theo mô tả của QA.
- **3.4. Deep Trace Capture (CDP):**
  - **Console Errors:** Bắt toàn bộ runtime error (`Uncaught Exception`) kèm Stack Trace.
  - **Failed Network Requests:** Lọc các API trả về HTTP Status `4xx`, `500` hoặc `Timeout`.
  - **Initiator Tracking:** Truy vết file/function ở Frontend đã kích hoạt API lỗi đó (thông qua CDP `Network.getInitiator`).
  - **Source Map Resolution:** Nếu có Source Map (`.map`), dịch ngược các file đã minified (ví dụ: `app.a8f9d.js:10`) về đúng đường dẫn mã nguồn gốc (ví dụ: `src/services/cartService.ts:45`).
  - **Screenshot:** Chụp ảnh màn hình tại thời điểm phát sinh lỗi.

### Phase 4: Review & Human-in-the-Loop

- **4.1. Stream Realtime:** Backend gửi dữ liệu thu thập được (Log, Stack Trace, Screenshot) về Frontend qua **WebSocket / SSE**.
- **4.2. QA Action:** QA kiểm tra kết quả:
  - Nút **"Điều chỉnh"**: Cho phép gõ thêm ghi chú nếu Agent đi sai luồng.
  - Nút **"Duyệt & Tạo Issue"**: Chọn Assignee, Milestone, Labels và gửi lệnh tạo Issue.

### Phase 5: Đồng bộ GitLab Issue

- **5.1. Binary Upload:** Backend đẩy file Screenshot lên GitLab qua API POST /api/v4/projects/:id/uploads để lấy Markdown Attachment URL..
- **5.2. Create Issue:** Backend gọi GitLab REST API (POST /api/v4/projects/:id/issues) để tạo Issue với định dạng Markdown kỹ thuật tiêu chuẩn.

### Phase 6: Edge Cases & System Constraints

- **Action Timeout & Loop Limit:** Giới hạn tối đa 10 hành động per testcase. Nếu Agent không tìm thấy selector sau 30s, dừng luồng và trả về trạng thái "Needs Human Intervention".
- **GitLab Attachment Workflow:** Phải thực hiện Upload Binary -> Nhận Markdown Link -> Render vào Body Issue.

---

## 4. Chiến lược Tối ưu Hóa Token & Chi phí LLM (Token Optimization Strategy)

### 4.1. Accessibility Tree Snapshot (Tối ưu DOM Input)

- **Vấn đề:** Việc gửi trực tiếp toàn bộ `document.body.innerHTML` khiến Input Token phồng lên 20,000 – 50,000 tokens mỗi lượt thao tác.
- **Giải pháp:** Backend chỉ trích xuất **Accessibility Tree (AXTree)** hoặc thực hiện DOM Pruning thông qua CDP:
  - Chỉ giữ lại các phần tử có khả năng tương tác (`<button>`, `<input>`, `<a>`, `[role]`, `[aria-label]`).
  - Loại bỏ toàn bộ phần tử định dạng, CSS class, SVG rác và text nội dung tĩnh không có ngữ cảnh điều hướng.

- **Hiệu quả:** Giảm 80% – 90% lượng Input Token tiêu tốn ở mỗi bước điều hướng UI (~1,000 – 2,000 tokens/step).

### 4.2. Context Trimming & Sliding Window (Tối ưu Context Loop)

- **Vấn đề:** Vòng lặp ReAct tích lũy snapshot của toàn bộ các bước cũ sẽ khiến số lượng token tăng theo cấp số cộng qua từng bước.
- **Giải pháp:**
  - Không giữ lại cây AXTree/DOM snapshot của các bước tương tác quá khứ trong lịch sử chat.
  - Tóm tắt các hành động đã thực hiện thành danh sách nhật ký ngắn (Action Log History), ví dụ:

    ```text
    [Step 1: Clicked #btn-add-cart] -> [Step 2: Filled input#quantity with "2"]
    ```

- Chỉ cung cấp **AXTree của trang hiện tại** trong prompt cho LLM ở lượt gọi tiếp theo.

- **Hiệu quả:** Giữ cho dung lượng Context Window ở mức ổn định thay vì phồng to theo số bước.

### 4.3. Prompt Caching Mechanism

- **Vấn đề:** System Prompt, định nghĩa Schema của các MCP Tools (`click`, `fill`, `navigate`), và cấu hình dự án liên tục bị gửi lại trong mọi request API của cùng một lượt test.
- **Giải pháp:** Tận dụng tính năng **Prompt Caching** của Provider (Anthropic / OpenAI):
  - Gắn tag caching (`ephemeral`) cho phần System Prompt tĩnh và Tool Definitions.
  - Chỉ phần User Prompt (trạng thái AXTree hiện tại và Action Log) mới tính chi phí Input Token đầy đủ.

- **Hiệu quả:** Giảm tới 90% chi phí xử lý Input Token cố định từ bước tương tác thứ 2 trở đi.

### 4.4. Tiered Model Orchestration (Mô hình LLM 2 tầng)

- **Vấn đề:** Các mô hình cao cấp (như Claude 3.5 Sonnet, GPT-4o) có chi phí cao nếu phải gọi liên tục cho các thao tác click/fill đơn giản.
- **Giải pháp:** Phân chia nhiệm vụ xử lý cho 2 tầng mô hình:
  - **Tầng 1 - Navigation Execution (Lightweight Model):** Sử dụng các mô hình nhỏ, tốc độ cao và chi phí thấp (như `Claude 3.5 Haiku` hoặc `GPT-4o-mini`) để đảm nhận vòng lặp ReAct tương tác UI (đọc AXTree, phát lệnh click/fill form).
  - **Tầng 2 - Analysis & Report Generation (Capable Model):** Chỉ kích hoạt mô hình lớn (như `Claude 3.5 Sonnet` hoặc `GPT-4o`) ở bước cuối cùng (Phase 4 & 5) khi cần tổng hợp Stack Trace, Source Map, phân tích nguyên nhân gốc rễ và biên soạn Issue Markdown chuẩn hóa.

- **Hiệu quả:** Tiết kiệm 60% – 70% tổng chi phí API cho toàn bộ quy trình end-to-end.

---

## 5. Cấu trúc Markdown GitLab Issue (Template)

````markdown
## Functional Summary

[Mô tả lỗi từ góc nhìn QA / Steps to reproduce đã được AI tóm tắt ngắn gọn]

## Technical Stack Trace (Auto-Captured)

> **Primary Failed Request:** `POST /api/v1/checkout` (Status: 500 Internal Server Error)

### Frontend Initiator & Source Trace

- **Triggered Component:** `src/views/CheckoutView.vue` (Line 87)
- **Initiator File:** `src/services/orderApi.ts` (Line 34)
- **Error Handlers / Utilities:** `src/utils/httpParser.ts` (Line 12)

### Console Runtime Errors

```text
TypeError: Cannot read properties of undefined (reading 'item_id')
    at parseCartResponse (src/utils/parser.ts:18:24)
    at handleCheckoutSubmit (src/views/CheckoutView.vue:89:12)
```

### Failed Network Request Payload

- **URL:** `https://staging-api.yourcompany.com/api/v1/checkout`
- **Method:** `POST`
- **Response Body:**

```json
{
  "code": "ERR_INVALID_PAYLOAD",
  "message": "Field 'user_id' is required but received null"
}
```

## Environment & Screenshots

- **Target URL:** `https://staging.yourcompany.com/cart/checkout`
- **Test Account Role:** `VIP Customer`
- **Captured Screenshot:** ![Bug Screenshot]([URL_IMAGE_ATTACHMENT])
````
