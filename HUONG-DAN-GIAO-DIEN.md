# Dùng giao diện DeepSeek Harness

Giao diện Harness: **http://127.0.0.1:3080**. Ứng dụng EduMatch: **http://localhost:3000**. Bấm đúp `MO-DEEPSEEK-HARNESS.cmd` để reset phiên cũ, khởi động backend và mở đúng URL xác thực.

Preset **EduMatch — build & deploy** có 6 observer tool cùng `read`, `write`, `edit`, `glob`, `grep`, `pwsh` và background jobs. Trên Windows, `pwsh` thay cho Bash. Preset có thể sửa code, chạy test/Docker/GitHub CLI và triển khai AWS staging bằng profile đã cấu hình. Credential store, `.env` và `.aws` không được in hoặc đọc trực tiếp; thao tác cloud dùng CLI/profile.

## Mở và tắt

Nhanh nhất: bấm đúp `MO-DEEPSEEK-HARNESS.cmd`.

Hoặc mở PowerShell và chạy:

```powershell
cd 'D:\deepseek harness'
npm run ui
```

Chờ dòng `Harness UI ready`. Giữ cửa sổ này chạy; `Ctrl+C` tắt Harness và broker do lệnh này tạo. Lần khởi động đầu có thể lâu hơn các lần sau. Nếu trang yêu cầu xác thực, chạy `./Mo-Harness.ps1` để mở URL đăng nhập của phiên đang chạy.

## Test giao diện

1. Workspace mặc định là `deepseek harness`; có thể test chat ngay tại đây. Nếu muốn chọn riêng repo, bấm **Add workspace** rồi chọn thư mục `D:\deepseek harness\edumatch` trong hộp chọn thư mục.
2. Chọn workspace muốn dùng, tạo **New session**.
3. Preset dùng **EduMatch — build & deploy**; model mặc định lấy từ `DEEPSEEK_MODEL` trong `.env`.
4. Nhập một prompt, ví dụ: `Kiểm tra AWS identity và repo, rồi cho biết staging đã sẵn sàng deploy chưa.`

Nếu chưa điền cấu hình API, trang vẫn mở nhưng gửi prompt sẽ báo thiếu cấu hình. Đây là lỗi cấu hình thật; Harness không tạo câu trả lời giả.

## Bật chat với DeepSeek thật

Điền các trường sau trong `.env`, rồi tắt và mở lại Harness:

```dotenv
DEEPSEEK_API_KEY=<key của bạn>
DEEPSEEK_INPUT_PRICE_CEILING_PER_M=<USD tối đa cho 1 triệu input token>
DEEPSEEK_OUTPUT_PRICE_CEILING_PER_M=<USD tối đa cho 1 triệu output token>
DEEPSEEK_PRICE_VERIFIED_AT=<ngày giờ ISO sau khi bạn kiểm tra giá>
```

Giữ key ở `.env` như cấu hình tập trung đã yêu cầu. Không cần nhập key vào Settings của web. Hai mức giá là mức trần dương dùng để giữ ngân sách, cần cập nhật từ trang giá chính thức trước khi dùng; ngày kiểm tra phải trong 7 ngày gần nhất.

Giao diện hiện đặt `DEEPSEEK_UI_UNLIMITED=true`, nên gateway không chặn theo tổng tiền, số lượt, tổng token hoặc thời gian phiên. Request có trần kỹ thuật riêng `DEEPSEEK_UI_MAX_REQUEST_BYTES=33554432` (32 MiB) để tránh cạn RAM; DeepSeek vẫn áp dụng context window của model. Đặt unlimited thành `false` để bật lại các trần ngân sách. Ngân sách AWS **50 USD/tháng** cấu hình riêng.

## Prompt thử

- `Gọi service_health cho local-fixture, ghi rõ đây là dữ liệu fixture và tóm tắt kết quả.`
- `Dùng workflow diagnose để phân tích triệu chứng matching trả lỗi. Chỉ dùng bằng chứng hiện có; liệt kê dữ liệu còn thiếu.`
- `Đọc metadata Redis và trạng thái RabbitMQ của target fixture, giải thích kết quả bằng tiếng Việt.`

Mặc định `EDUMATCH_ENVIRONMENT=fixture`: sáu công cụ `service_health`, `search_logs`, `db_schema`, `db_read_query`, `rabbitmq_status`, `redis_key_metadata` trả bằng chứng fixture. Docker EduMatch đang chạy thật không tự động biến những công cụ này thành observer live. Live cần tài khoản đọc riêng, cấu hình và các gate đã ghi trong README.

Preset web hiện có quyền sửa workspace và PowerShell đầy đủ, gồm background jobs cho build/deploy dài. AWS dùng `AWS_PROFILE` và `AWS_REGION` từ cấu hình tập trung; mỗi kết luận deploy phải dựa trên output/health thật.

## Lỗi thường gặp

- **Trang không mở:** đợi dòng ready; xem `.state/ui.stderr.log` và `.state/ui-broker.log`.
- **Thiếu cấu hình / CONFIGURATION_REQUIRED:** điền đủ bốn trường API ở trên và khởi động lại.
- **BUDGET_EXCEEDED:** phiên đã hết ngân sách; xem `.state/ui-provider-usage.json` sau khi tắt, rồi quyết định có mở phiên mới.
- **Cổng 3080/3091 đã dùng:** tắt phiên Harness cũ trước. Không chạy đồng thời hai lệnh `npm run ui`.
- **Ô chat bị khóa:** chọn workspace và tạo session.
- **Kết quả fixture:** đó là chế độ mặc định, chưa phải kết quả chẩn đoán Docker/AWS thật.
