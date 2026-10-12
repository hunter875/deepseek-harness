## Vấn đề

`chat-service` trả **503** cho mọi request. Phiên staging trước kết luận nguyên
nhân là "caller không gửi credential". Đọc source cho thấy kết luận đó **sai**.

### Nguyên nhân thật

| # | Sự thật | Bằng chứng |
| --- | --- | --- |
| A | Chat **có** gửi `Authorization: Bearer <token>` | `ChatService` (trước đây) dòng 370-372 |
| B | Token đó là token **của người dùng** (`ROLE_USER`) | truyền `authentication.getCredentials()` |
| C | Endpoint yêu cầu `ROLE_ADMIN` hoặc `ROLE_SERVICE` | `UserController` `@PreAuthorize` |
| D | **`ROLE_SERVICE` không tồn tại** trong hệ thống | không có trong `InitialDataLoader`, không có trong migration |

Vì (B)+(C)+(D), **không caller nào ngoài admin có thể thoả** guard. Đây là lỗi
phân quyền, không phải thiếu credential.

`scholarship-service` đã gặp đúng bug này và sửa bằng cách dùng `GET /api/user/me`
(`ScholarshipUserLookupService`, comment ghi rõ lý do). PR này áp dụng cùng cách
cho chat-service và bổ sung danh tính service cho các lookup cần tra **người khác**.

### Bug thứ hai: dedup event không hoạt động

`processed_events` rỗng dù consumer log báo đã xử lý 3 event. Nguyên nhân:
`UserProfileEventPayloadFactory` không sinh trường `event_id`, nên consumer rơi
vào nhánh "không có event id" — bỏ qua `claim_event()` và không bao giờ gọi
`mark_event_processed()`. **At-least-once redelivery được xử lý lại, không dedup.**

### Bug thứ ba: default cấu hình trỏ host local-only

`chat-service` `application.properties`:
`app.services.auth-service.url=${AUTH_SERVICE_URL:http://auth-service-test:8081}` —
hostname chỉ tồn tại trên máy dev. Đã sửa thành tên trong network.

### Bug thứ tư: phụ thuộc thừa vào shared secret

`app.jwt.secret` bắt buộc không default, nhưng `JwtTokenProvider` chỉ đọc nó trên
đường HS256 fallback — đường không thể tới khi RSA được cấu hình và `require-rsa`
là true (nó throw thay vì fallback). Việc bắt buộc khai báo khiến mọi deployment
RSA phải cấp một shared secret không bao giờ dùng, dễ bị hiểu nhầm là khoá ký thật.

## Thay đổi

**Chat → Auth (danh tính service)**
- Thêm client-credentials exchange `POST /api/service/token`, cấp token RS256
  ngắn hạn chỉ mang `ROLE_SERVICE`
- Seed `ROLE_SERVICE`
- Service auth **tắt mặc định**; bật phải kèm secret ≥32 ký tự, nếu thiếu thì
  **từ chối mọi request** thay vì cấp token
- `ServiceTokenClient` cache token, không bao giờ fallback sang request không xác thực
- Self-lookup dùng `/api/user/me`; lookup người khác dùng service token

**Cấu hình tại nguồn**
- Sửa default `AUTH_SERVICE_URL`
- Bỏ regex rewrite mọi giá trị env, thay bằng cấu hình tường minh cho từng URL liên service

**Event dedup**
- `UserProfileEventPayloadFactory` sinh `event_id` mới cho mỗi event

**JWT**
- `app.jwt.secret` default rỗng ở cả 3 service; release transform **xoá**
  `APP_JWT_SECRET`/`JWT_SECRET` khỏi container env

## Test

`ServiceTokenServiceTest` (auth): credential hợp lệ, sai, client lạ, rỗng, exchange
tắt, secret cấu hình ngắn, header RS256, chống giả mạo chữ ký, TTL bị chặn, token
chỉ mang `ROLE_SERVICE`.

`ServiceTokenClientTest` (chat): thành công, tắt, bị từ chối, thiếu token trong
response, cache (1 lần exchange cho 3 lần gọi), invalidate, credential đi trong
POST body chứ không phải URL.

`UserProfileEventPayloadFactoryTest`: `event_id` có mặt, khác nhau mỗi event, đúng dạng UUID.

## Chưa làm trong PR này

- `permitAll` cho `/api/internal/**` — **cố ý không làm**; giữ nguyên guard
- OIDC claim, restore drill, rollback migration, load test — backlog
- Frontend browser test — chưa chạy, cần SSM tunnel + trust cert

## Kiểm chứng

Test tooling: 32 Node + 41 bash = 73 PASS (workspace DSH, không thuộc PR này).
Test ứng dụng (`ServiceTokenServiceTest`, `ServiceTokenClientTest`): **chưa chạy**
— host không có JDK; sẽ chạy trên EC2 trong phiên staging tiếp theo.
