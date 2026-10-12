# Task contract — Chat → Auth service-to-service authorization

## Trạng thái: VERIFIED (nguyên nhân đã xác minh lại từ source)

## 1. Bối cảnh

Phiên staging trước kết luận sai một phần. Báo cáo cũ nói chat-service gọi
`/api/internal/user/*` **không có credential**. Đọc source cho thấy điều đó
không đúng.

## 2. Nguyên nhân thật (có bằng chứng file:line)

| # | Sự thật | Bằng chứng |
| --- | --- | --- |
| A | Chat **có** gửi `Authorization: Bearer <token>` | `ChatService.java:370-372` |
| B | Token gửi là token **của người dùng** (`ROLE_USER`) | `ChatService.java:312-315` truyền `authentication.getCredentials()` |
| C | Endpoint yêu cầu `ROLE_ADMIN` hoặc `ROLE_SERVICE` | `UserController.java:219,229,239` |
| D | **`ROLE_SERVICE` không tồn tại** trong hệ thống | grep toàn repo chỉ thấy trong `@PreAuthorize` và comment; không có trong migration seed |
| E | Vì (B)+(C)+(D): mọi caller không phải admin đều bị 403 | quan sát live: `403 Access Denied` |

**Kết luận:** đây là **lỗi phân quyền**, không phải thiếu credential. Không có
đường hợp lệ nào cho chat-service với thiết kế hiện tại.

## 3. Pattern đã có sẵn trong repo

`scholarship-service` đã gặp đúng bug này và sửa theo cách khác:

`ScholarshipUserLookupService.java:17-24`
> Prior implementation forwarded the user token to `/api/internal/user/{username}`
> which required ROLE_ADMIN / ROLE_SERVICE — roles ordinary users do not hold.
> The fix uses `GET /api/user/me` which reads the authenticated principal directly
> from the SecurityContext inside Auth-Service.

Đây là **cơ chế đang có, được tái sử dụng** theo yêu cầu "ưu tiên tái sử dụng
cơ chế đang có".

## 4. Phạm vi sửa

| Endpoint | Caller | Cách xử lý |
| --- | --- | --- |
| `GET /api/internal/user/{username}` | chat: resolve self | chuyển sang `GET /api/user/me` (token người dùng) |
| `GET /api/internal/user/id/{userId}` | chat: resolve người khác theo ID | cần danh tính **service** |
| `GET /api/internal/users?ids=` | chat: batch nhiều user | cần danh tính **service** |

Hai endpoint sau **không thể** thay bằng `/me` vì chúng tra **người khác**.
Chúng cần danh tính service. `ROLE_SERVICE` chưa tồn tại nên phải tạo, kèm
credential cho chat-service.

## 5. Quyết định thiết kế

Không dùng `permitAll`. Thay vào đó:

1. **Tạo `ROLE_SERVICE`** trong migration auth DB, gán cho một tài khoản service.
2. **Auth cấp service token** qua endpoint client-credentials có kiểm soát
   (client id + secret từ env, so sánh constant-time).
3. **Chat cache service token** và gửi nó cho 2 endpoint tra người khác.
4. **Endpoint self** (`/internal/user/{username}`) chuyển sang `/api/user/me`
   như scholarship đã làm, để đường resolve chính không cần service token.

Giữ nguyên `@PreAuthorize` trên các endpoint internal — không nới quyền cho
người dùng thường.

## 6. Acceptance

| ID | Hành vi | Verifier |
| --- | --- | --- |
| A1 | Caller hợp lệ có `ROLE_SERVICE` gọi được 3 endpoint internal | test tích hợp |
| A2 | Không credential → 401 | test |
| A3 | Credential sai/hết hạn → 401 | test |
| A4 | Token người dùng thường (`ROLE_USER`) gọi endpoint internal → 403 | test |
| A5 | Chat REST resolve được người dùng khác | test + live |
| A6 | Chat WebSocket handshake resolve được danh tính | test + live |
| A7 | Truy cập conversation không thuộc mình → 403 | test |
| A8 | JWT: signature, expiry, issuer, audience | test |
| A9 | `AUTH_SERVICE_URL` đúng ở local **và** staging | test config |
| A10 | Không còn regex rewrite mọi env value | review + test |
| A11 | Preflight Compose với runtime env thật, không in secret | tooling test |

## 7. Ngoài phạm vi

- OIDC GitHub claim (backlog)
- restore drill, RPO/RTO (backlog)
- rollback có migration (backlog)
- load test (backlog)
- Redis cache nếu chứng minh là chưa triển khai → báo NOT IMPLEMENTED, không
  tạo số liệu giả

## 8. Ngân sách

EC2 giữ **stopped** trong lúc sửa. Chỉ bật lại sau khi offline/CI check xong,
tối đa 2 giờ, không nâng máy, không tạo hạ tầng tính phí mới.
