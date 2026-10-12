# Phiên sửa lỗi sau AWS staging — kết quả

Bổ sung cho `docs/STAGING-SESSION-RESULTS.md` (phiên deploy đầu tiên).
Phiên này sửa nguyên nhân gốc trong **source**, không workaround ở tầng deploy.

## 1. Nguyên nhân đã xác minh lại — báo cáo trước SAI một phần

Báo cáo phiên trước nói chat-service gọi `/api/internal/**` **"không có
credential"**. Đọc source cho thấy điều đó không đúng. Sự thật:

| # | Sự thật | Bằng chứng |
| --- | --- | --- |
| A | Chat **có** gửi `Authorization: Bearer <token>` | `ChatService` (bản cũ), nhánh `getUserDetailsFromAuthService` |
| B | Token đó là token **của người dùng** | truyền `authentication.getCredentials()` |
| C | Endpoint yêu cầu `ROLE_ADMIN`/`ROLE_SERVICE` | `UserController` `@PreAuthorize` trên cả 3 endpoint |
| D | **`ROLE_SERVICE` không tồn tại** | không có trong `InitialDataLoader`, không có trong migration |

Vì (B)+(C)+(D), không caller nào ngoài admin thoả được guard. Đây là **lỗi phân
quyền**, không phải thiếu credential.

`scholarship-service` đã gặp đúng bug này và sửa bằng `/api/user/me`
(`ScholarshipUserLookupService`, comment ghi rõ lý do). Phiên này áp dụng cùng
cách và bổ sung danh tính service cho các lookup cần tra **người khác**.

## 2. Bảng vấn đề và vị trí fix

| # | Vấn đề | Vị trí fix | Trạng thái |
| --- | --- | --- | --- |
| 1 | `ROLE_SERVICE` không tồn tại | `InitialDataLoader` seed role | FIXED |
| 2 | Không có đường lấy danh tính service | `ServiceTokenService` + `ServiceAuthController` (`POST /api/service/token`) | FIXED |
| 3 | Chat tra người khác bằng user token | `ServiceTokenClient` + `ChatService` dùng service token | FIXED |
| 4 | Chat tra chính mình bằng endpoint internal | `ChatService` + `WebSocketAuthInterceptor` dùng `/api/user/me` | FIXED |
| 5 | `AUTH_SERVICE_URL` default là host local-only | `chat-service/application.properties` | FIXED |
| 6 | Event không có `event_id` → dedup không chạy | `UserProfileEventPayloadFactory` | FIXED |
| 7 | Phụ thuộc thừa vào shared secret dưới RS256 | `app.jwt.secret` default rỗng ở 3 service | FIXED |
| 8 | Regex rewrite mọi env value | `prepare-release.mjs` thay bằng cấu hình tường minh | FIXED |
| 9 | Deadline phiên reset khi stop/start | `max-session.sh` dùng timestamp UTC cố định | FIXED |
| 10 | Local Compose không set `AUTH_SERVICE_URL` cho chat | `docker-compose.yml` | FIXED |
| 11 | Không có preflight Compose | `scripts/preflight-compose.ps1` | ADDED |
| 12 | `/api/internal/**` 403 với chat | xem #1–#4 | FIXED |

## 3. Quyết định thiết kế

**Không** dùng `permitAll` cho `/api/internal/**`. Guard `@PreAuthorize` giữ
nguyên. Thay vào đó:

- Token service là RS256, cùng đường ký và cùng validator với token người dùng,
  nên signature/expiry/issuer/audience được kiểm bởi **cùng một code**
- Token chỉ mang `ROLE_SERVICE`, không có `userId` — service principal không phải user
- Exchange **tắt mặc định**; bật phải kèm secret ≥32 ký tự, nếu thiếu thì **từ
  chối mọi request** thay vì cấp token
- So sánh secret bằng `MessageDigest.isEqual` (constant-time)
- `ServiceTokenClient` không bao giờ fallback sang request không xác thực

## 4. Test

### Test ứng dụng (Java, chạy trên CI)

| Test | Số case | Kết quả |
| --- | --- | --- |
| `ServiceTokenServiceTest` | 9 | PASS |
| `UserProfileEventPayloadFactoryTest` | 3 (2 mới) | PASS |
| `ServiceTokenClientTest` | 8 | PASS |
| auth-service tổng | 35 | PASS, 0 skipped |
| chat-service tổng | 10 | PASS, 0 skipped |

Bằng chứng CI run `37000755245`, 6/6 job success:
`Docker Compose config`, `Frontend`, `Java tests (auth|scholarship|chat)`, `Matching service`.

### Test tooling (workspace DSH)

32 Node + 41 bash = **73 PASS**.

## 5. Redis — làm rõ

`DBSIZE=0` trong phiên trước là **lỗi test của tôi**, không phải cache hỏng.

- Endpoint **có** cache: `GET /api/v1/scholarships` (`V1ScholarshipController`)
- Endpoint tôi test: `GET /api/scholarships?isPublic=true` — đường legacy,
  **không** dùng `ScholarshipPublicReadCacheService`

Cache chưa từng bị gọi. `CacheConfig` được triển khai đầy đủ: prefix
`scholarship:<name>::`, TTL 60s/5m, `@Cacheable`/`@CacheEvict` rõ ràng.

**Trạng thái: NOT VERIFIED trên staging** — cần gọi đúng endpoint và chứng minh
miss → write → hit. Không tạo số liệu giả.

## 6. `processed_events` — nguyên nhân đã xác định

Consumer claim mỗi delivery trong `processed_events` theo `event_id`, nhưng
publisher không set trường đó. Consumer rơi vào nhánh "không có event id" → bỏ
qua `claim_event()`, không gọi `mark_event_processed()`. Ledger luôn rỗng và
**at-least-once redelivery bị xử lý lại, không dedup**.

Đây là bug thật, nghiêm trọng hơn mô tả "mâu thuẫn chưa giải thích" trong báo
cáo trước. Đã sửa và có test.

## 7. Chi phí — công thức và đối chiếu

```
total = (Σ line items) × (1 + taxPercent/100)
line items = ec2(hours×rate) + ebs(rootGb+dataGb × rate) + snapshots
           + ecr + logs(ingest+storage+query) + ipv4(hours×rate)
           + transfer + s3(storage + requests)
```

`m7i-flex.large` = **0.1197 USD/giờ** (giá thật từ AWS regional catalog).

| Kịch bản | USD/tháng |
| --- | --- |
| 40h chạy / 690h stop | **17.57** |
| 0h chạy / 730h stop | **10.03** |
| 730h chạy / 0h stop | **120.82** (vượt trần 50) |

**Đối chiếu từng khoản (40h):**
`ec2 4.788 + ebs 5.76 + snapshots 1.5 + ecr 0.30 + logs 0.737 + ipv4 0.2 + transfer 0.6 + s3 0.759 = 14.644`
`14.644 × 1.20 (thuế/phí) = 17.5728` = `totalUsd`. **Khớp.**

`cost.mjs` giờ xuất `reconciliation` với `check: true/false` và
`unexplainedUsd`, kèm gate chặn nếu tổng không khớp line items.

**Về con số 2.79 USD:** tôi **không tìm thấy** nó trong bất kỳ artifact nào của
workspace. Các lần xuất hiện chuỗi "2.79" chỉ là giá instance type khác trong
AWS pricing catalog (`c7g.16xlarge`, `m6gd.12xlarge`). Cần bạn chỉ nguồn để đối
chiếu; tôi không suy đoán.

**Cost Explorer hiển thị 0.00 USD không có nghĩa miễn phí.** Billing trễ tới 24h,
credits có thể che usage. Các khoản vẫn tích luỹ: EBS 60 GB, snapshot, ECR
storage, S3, CloudWatch logs. Cần tách `usage cost` / `credits` / `số phải trả`
— việc này cần quyền đọc billing, hiện chưa cấp.

## 8. Vòng đời phiên

Deadline là **timestamp UTC cố định**, không phải duration từ boot:

- `session-deadline-epoch` là nguồn chính; `session-deadline` là bản đọc được
- Tạo một lần khi chưa có deadline, hoặc khi deadline đã qua
- **Stop/start trong cùng phiên KHÔNG gia hạn** — có test chứng minh
- 17 test cho `max-session.sh`

## 9. Bàn giao

| Hạng mục | Giá trị |
| --- | --- |
| Branch | `fix/chat-auth-service-identity` |
| Draft PR | https://github.com/hunter875/edumatch-production/pull/10 |
| Commits | `4917295`, `78ae066`, `7d09b85`, `5450cdc` |
| CI | run `37000755245` — 6/6 success |

## 10. Backlog (không thuộc phiên này)

| Mục | Trạng thái |
| --- | --- |
| GitHub OIDC claim verification | NOT IMPLEMENTED |
| Restore drill, RPO/RTO | NOT IMPLEMENTED |
| Rollback khi migrationDigest khác | NOT TESTED |
| Load test / capacity thực tế | NOT TESTED |
| Frontend browser test | NOT TESTED — cần SSM tunnel + trust cert |
| Redis cache miss/write/hit trên staging | NOT VERIFIED |
| Tách usage cost / credits / payable | NEEDS DECISION — cần quyền billing |
| Email verification flow | NOT IMPLEMENTED — `EmailService` không có caller |
