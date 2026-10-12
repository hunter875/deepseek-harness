# Phiên staging EduMatch — kết quả và bằng chứng

Phiên: 2026-10-02. Account `741269129377`, region `ap-southeast-1`.
Instance `i-019a0c2a898eb9800` (`m7i-flex.large`, Amazon Linux 2023).
Release cuối: **`bb28dad0773a7caf970835e2fbdb3918bd232c45-7`** (đang chạy).

## Bằng chứng nào là live, bằng chứng nào không

Mọi kết quả dưới đây đến từ EC2 thật, qua SSM, đọc từ container/DB/broker đang
chạy. Không có kết quả nào lấy từ fixture hay mô phỏng. Các mục **NOT TESTED**
được ghi rõ cùng blocker thay vì suy đoán.

## 1. Hạ tầng

| Hạng mục | Giá trị thực |
| --- | --- |
| AMI | `ami-0595d03ac6eb6e3a7` (Amazon Linux 2023, x86_64) |
| Instance type | `m7i-flex.large` — 2 vCPU / 8 GiB |
| EBS data | `vol-0b66e4472200b5195`, ext4, UUID `52886dab-df0e-4ab6-9e4e-ab20fad62b75` |
| ECR | 6 repo `edumatch-staging/*`, IMMUTABLE |
| S3 | `edumatch-staging-releases-741269129377` |
| Budget | `edumatch-staging-monthly`, 50 USD, cảnh báo 50/80/100% |

`terraform plan` = 33 resource, `apply` thành công. Ba nguồn cấu hình khớp nhau:
`.env` = `infra/terraform.tfvars.json` = thực tế AWS.

## 2. Auto-stop

Timer `edumatch-max-session.timer`: **active**, **enabled**, giới hạn **4 giờ**.
Đo từ `/proc/uptime`, nên stop/start cấp lại cửa sổ mới. Đã kiểm chứng:

- sau reboot instance: timer vẫn `active`/`enabled`
- giá trị 0, 99 và chuỗi không phải số bị từ chối (11 test trong `tests/max-session.test.sh`)

## 3. Kết quả test chức năng

| ID | Luồng | Kết quả | Bằng chứng |
| --- | --- | --- | --- |
| T1 | Đăng ký | **PASS** | HTTP 200, JWT header `{"alg":"RS256"}` — RSA thật, không phải HS256 |
| T2 | Đăng nhập | **PASS** | HTTP 200, access token 615 ký tự, refresh cookie được set |
| T3 | Sai mật khẩu | **PASS** | HTTP 401 `Invalid username or password` (không phải 5xx) |
| T4 | Gọi ẩn danh | **PASS** | HTTP 401 trên endpoint được bảo vệ |
| T5 | `/api/auth/me` với token | **PASS** | HTTP 200, dữ liệu thật: `roles:["ROLE_USER"]`, `status:ACTIVE` |
| T6 | Refresh token | **PASS** | HTTP 200, token mới phát hành |
| T7 | Danh sách học bổng public | **PASS** | HTTP 200, JSON phân trang hợp lệ |
| T8 | Tạo học bổng bằng ROLE_USER | **PASS (phân quyền)** | HTTP 403 — đúng: endpoint yêu cầu `ROLE_EMPLOYER` |
| T9 | Matching health | **PASS** | `{"status":"healthy","service":"Matching Service",...}` |
| T10 | Chat API | **FAIL** | HTTP 503, xem mục 5 |
| T11 | WebSocket | **PASS** | `HTTP/1.1 101 Switching Protocols`, có `X-App-Version` đúng revision |
| T12 | RabbitMQ event | **PASS** | consumer xử lý `user.profile.updated` cho applicant 1, 2, 3 |
| T13 | Redis cache | **FAIL** | `DBSIZE=0`, không có key nào được ghi |
| T14 | DB persistence | **PASS** | `auth_db.users` = 3 dòng, khớp số lần đăng ký |
| T15 | Restart container | **PASS** | 13/13 healthy trở lại, dữ liệu còn nguyên |
| T16 | Stop/start EC2 | **PASS** | dữ liệu còn nguyên, volume mount đúng, timer tự phục hồi |
| T17 | Rollback | **PASS** | từ `-7` về `-6`, gateway báo đúng `releaseId` |

### Bằng chứng event pipeline (T12)

```
applicant_features = 3 rows
 5d72a9cd-... | 1 | ... | 2026-10-02 07:00:36
 32ce842b-... | 2 | ... | 2026-10-02 07:11:38
 b0f28869-... | 3 | ... | 2026-10-02 07:17:13
```

Ba dòng khớp chính xác ba lần đăng ký, và log consumer xác nhận
`Executed handler for routing_key: user.profile.updated`. Đây là bằng chứng DB,
không phải chỉ log.

## 4. Bug đã tìm và sửa trong phiên

Tất cả đều là lỗi thật, chỉ lộ ra khi chạy trên hạ tầng thật:

| # | Bug | Sửa |
| --- | --- | --- |
| 1 | `bootstrap-data-volume.sh` treo 300s vì `vol` prefix không khớp khi chuẩn hoá volume ID | hàm `normalize_volume_id()` dùng chung |
| 2 | Runtime env thiếu `SPRING_MAIL_USERNAME/PASSWORD` | thêm, và sinh env kiểm tra chéo với Compose thật |
| 3 | Image build thiếu label `org.opencontainers.image.revision` | thêm label, khớp CI |
| 4 | Spring resolve `/run/secrets/*.pem` thành classpath resource | dùng scheme `file:` |
| 5 | File secret `0600 root` không đọc được bởi uid 100/10001 | `chgrp 101` + `0640`, public `0644`, và `release.sh` tự đặt lại |
| 6 | `MailHealthIndicator` làm actuator trả 503 vĩnh viễn | tắt indicator (nghiệp vụ không gửi mail) |
| 7 | `compose up --wait` fail vì `matching-consumer` cố ý không có healthcheck | chỉ wait các service có healthcheck |
| 8 | curl từ chối self-signed cert | dùng `--cacert` (không dùng `-k`) |
| 9 | Hostname `-test` sót trong env | rewrite tổng quát + gate chặn trong `release_guard.py` |
| 10 | `AUTH_SERVICE_URL` mặc định trỏ `auth-service-test` | inject giá trị đúng cho chat/scholarship |
| 11 | `prepare-release.mjs` từ chối mọi release nối tiếp | chuyển kiểm tra `expectedPreviousRelease` sang guard trên host |

Mỗi bug đều kèm test hồi quy hoặc gate để không tái diễn.

## 5. FAIL và giới hạn chưa giải quyết

### T10 — Chat API trả 503

Chat-service gọi `GET /api/internal/user/{username}` trên auth-service và nhận
**403 Access Denied**. Nguyên nhân nằm trong source, không phải cấu hình deploy:

`auth-service/SecurityConfig.java` chỉ `permitAll` cho `/api/auth/*`,
`/api/public/**`, `/actuator/health`, `/uploads/**`. `/api/internal/**` rơi vào
`.anyRequest().authenticated()`, mà chat-service gọi endpoint này **không kèm
token** → 403.

Việc sửa nằm ngoài phạm vi phiên này vì nó thay đổi quy tắc bảo mật của ứng
dụng. Cần một trong: cấp service credential cho chat-service, hoặc mở
`/api/internal/**` cho mạng nội bộ kèm kiểm soát khác.

### T13 — Redis không có key

`DBSIZE=0` sau khi đã có 3 user, học bổng được đọc và event được xử lý. Nghĩa là
đường cache chưa từng được ghi trong các luồng đã test, dù
`MANAGEMENT_HEALTH_REDIS_ENABLED=true`. Đây là **chưa quan sát được hành vi
cache**, không phải bằng chứng cache hỏng; cần lưu lượng đọc lặp lại để kết luận.

### T12 phụ — `processed_events` = 0

Consumer log nói đã xử lý nhưng ledger idempotency trống. Hai nguồn này mâu
thuẫn; chưa xác định được là do ghi ở transaction khác, do bảng khác, hay do
ledger chỉ ghi khi có va chạm. Ghi nhận là **điểm chưa giải thích**, không kết
luận.

### Frontend trên trình duyệt — NOT TESTED

Chưa chạy. Blocker cụ thể: cần thêm `127.0.0.1 edumatch.staging.local` vào hosts
file và import chứng chỉ vào Root store — cả hai cần quyền Administrator trên
máy Windows này — đồng thời cần một phiên SSM port-forwarding chạy song song.
Phần này **tách riêng** khỏi kết quả API test trong instance; các API test đều
đi qua gateway thật với TLS được xác thực bằng `--cacert`.

Kiểm chứng được qua API: WebSocket trả `101` với header gateway, TLS dùng
`--cacert` (không tắt xác thực), và cookie `Secure` được set
(`APP_AUTH_COOKIE_SECURE=true`). Chưa kiểm chứng được hành vi trình duyệt: lưu
cookie, redirect sau đăng nhập, kết nối WebSocket từ JS.

## 6. Chi phí

Đơn giá lấy từ AWS regional bulk catalog cho `ap-southeast-1`:

```
total = (Σ components) × (1 + taxPercent/100)
components = ec2(hours×rate) + ebs(60GB×rate) + snapshots + ecr
           + logs(ingest+storage+query) + ipv4(hours×rate)
           + transfer + s3(storage + requests)
```

`m7i-flex.large` = **0.1197 USD/giờ** (giá thật từ catalog; `t3a.large`
0.0944 USD/giờ không dùng được vì account Free Tier chặn).

| Kịch bản | USD/tháng |
| --- | --- |
| 40 h chạy | 17.57 |
| Dừng cả tháng | 10.03 |
| Chạy 24/7 | 120.82 (vượt trần 50) |
| Mỗi phiên 4 h | 0.75 |

**Cost Explorer hiển thị 0.00 USD không có nghĩa là miễn phí.** Billing có độ
trễ tới 24 giờ, và account Free Tier có thể được credits bao phủ. Các khoản vẫn
tích luỹ bất kể hiển thị: EBS 60 GB, snapshot, ECR storage, S3, CloudWatch logs.

## 7. Release baseline cho phiên sau

| Release | Trạng thái |
| --- | --- |
| `...-5` | deploy thành công đầu tiên |
| `...-6` | sửa hostname `-test` |
| **`...-7`** | **release cuối, đã rollback và deploy lại thành công** |

Rollback đã kiểm chứng thật (`-7` → `-6` → `-7`). `release_guard.py` chặn
rollback khi migration digest khác, nên rollback chỉ an toàn ở mức code.

### Trạng thái cuối phiên

```txt
RELEASE            bb28dad0773a7caf970835e2fbdb3918bd232c45-7
CONTAINERS_TOTAL   13
CONTAINERS_HEALTHY 12   (matching-consumer cố ý không có healthcheck)
DATA_UUID          52886dab-df0e-4ab6-9e4e-ab20fad62b75
SESSION_LIMIT      4 giờ
TIMER              active
USERS              3
```

Test suite trước khi đóng phiên: **32 Node + 35 bash = 67 PASS, 0 fail**;
`terraform validate` hợp lệ.

## 8. Lệnh vận hành

```powershell
# Bật máy
pwsh scripts/staging-session.ps1 -Action start
pwsh scripts/staging-session.ps1 -Action status

# Kết nối (cần hosts entry + trust cert, xem docs/STAGING-MANUAL-DEPLOY.md)
pwsh scripts/staging-session.ps1 -Action connect

# Deploy / rollback
pwsh scripts/staging-session.ps1 -Action deploy   -ReleaseId <sha>-<n>
pwsh scripts/staging-session.ps1 -Action rollback -RollbackRelease <sha>-<n>

# Test và log
pwsh scripts/staging-session.ps1 -Action health
pwsh scripts/staging-session.ps1 -Action logs -TailMinutes 30

# Dừng máy
pwsh scripts/staging-session.ps1 -Action stop
```
