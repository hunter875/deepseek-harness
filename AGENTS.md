# AGENTS.md — Bài học vận hành EduMatch

File này ghi lại những sai lầm **đã thực sự xảy ra** và cách tránh lặp lại.
Đọc file này trước khi làm việc trên EduMatch / AWS staging.

Nguyên tắc: chỉ ghi bài học có bằng chứng. Không ghi suy đoán, không ghi
"best practice" chung chung. Mỗi mục phải kèm dấu hiệu nhận biết để lần sau
phát hiện nhanh.

---

## 1. Deploy & release

### 1.1 Release build nginx từ `nginx.local.conf`, KHÔNG phải `nginx.conf`

**Đã sai 1 lần (2026-10-03).** Tôi sửa `nginx-gateway/nginx.conf`, viết test,
verify cú pháp pass — nhưng thay đổi đó **không bao giờ được deploy**.

Nguyên nhân: `scripts/prepare-release.mjs:112` đọc
`nginx-gateway/nginx.local.conf`. Và `docker-compose.yml:318` cũng mount
`nginx.local.conf`. `nginx.conf` không nằm trên đường deploy nào.

**Dấu hiệu:** sửa xong nhưng hành vi trên staging không đổi.

**Cách tránh:** trước khi sửa bất kỳ file config nào, grep xem file đó được
đọc bởi script deploy ở đâu:
```
grep -rn "ten-file.conf" scripts/ cloud/ edumatch/docker-compose.yml
```

### 1.2 Verify file đã lên host phải đối chiếu hash

Không tin "đã copy" hay "đã upload". Tính MD5 cả hai đầu và so:
```powershell
(Get-FileHash $local -Algorithm MD5).Hash.ToLower()
```
```bash
md5sum /opt/edumatch/build/edumatch/duong/dan/file
```
**Đã sai 1 lần:** tôi tưởng đã đẩy `nginx.local.conf` lên host, nhưng payload
trước đó chỉ chứa `nginx.conf`. Test cho kết quả sai (vẫn HTML 404) và tôi
suýt kết luận "fix không hoạt động".

### 1.3 Instance chỉ đọc được S3 prefix `releases/*`

Instance role có `s3:GetObject` trên `arn:aws:s3:::edumatch-staging-releases-741269129377/releases/*`
và **không có** `s3:ListBucket`. Đẩy file vào `verify/` → host nhận **403**.

Đây là thiết kế đúng (tối thiểu quyền). Đừng sửa IAM để lách — dùng đúng
prefix `releases/`.

### 1.4 Nhớ dọn payload tạm

Sau khi verify, xoá file tạm khỏi `releases/` để không lẫn với release thật:
```bash
aws s3 rm s3://edumatch-staging-releases-741269129377/releases/<ten>.tar
```

---

## 2. Phiên làm việc AWS

### 2.1 Deadline auto-stop cũ có thể đã qua — phải ghi lại trước khi test

**Đã suýt mất phiên test.** Deadline cũ `2026-10-03T07:23:58Z` đã qua khi bật
lại máy lúc 10:39Z. Timer `edumatch-max-session.timer` tick mỗi ~5 phút và sẽ
`systemctl poweroff` nếu deadline đã qua.

Cơ chế: systemd timer trên host đọc `/opt/edumatch/session-deadline-epoch`
(UTC epoch tuyệt đối, không phải duration). **Restart máy không cấp thêm giờ.**

**Quy trình bắt buộc sau khi start instance:**
```bash
cat /opt/edumatch/session-deadline-epoch; date -u +%s
# nếu deadline <= now, ghi lại NGAY trước khi làm gì khác
```

### 2.2 SSH bị tắt — mọi truy cập host qua SSM

`user-data.sh.tftpl` chạy `systemctl disable sshd`. Chỉ vào được bằng
`aws ssm send-command` với document `AWS-RunShellScript`.

**Bẫy:** truyền script qua `--parameters commands=...` rất dễ sai quoting
trong PowerShell. Cách chắc chắn: base64 nội dung script rồi giải mã trên host:
```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
$script = "echo '$b64' | base64 -d > /tmp/x.sh; bash /tmp/x.sh"
```
Payload base64 quá lớn (>64KB) thì SSM từ chối → đẩy qua S3.

### 2.3 AWS session hết hạn thường xuyên

Profile `edumatch-bootstrap` hết hạn sau vài giờ. Dấu hiệu:
```
aws: [ERROR]: Your session has expired. Please reauthenticate using 'aws login'.
```
Cần người dùng chạy `aws login` — agent không tự làm được.

### 2.4 Sandbox có thể chặn `~/.aws/login/cache/*`

Khi file policy là `workspace-write`, AWS CLI không đọc được token cache →
`[Errno 13] Permission denied`. Nếu gặp, cần escalate hoặc đổi policy sang
`danger-full-access`.

### 2.5 Máy không ra được internet — test từ trong instance

Workstation không mở được outbound (không gọi được `checkip.amazonaws.com`),
và security group chỉ mở 443 cho một CIDR cố định. Nên **không test được từ
máy** — phải chạy curl trên chính instance qua SSM:
```bash
curl -sk https://localhost/api/...
```
Đây vẫn là live evidence thật (JWT thật, DB thật), chỉ khác đường vào.

---

## 3. Kiểm chứng

### 3.1 "Compile pass" ≠ "hành vi đúng"

QA-2 (`status=ALL`) tôi chỉ verify được là code compile. Muốn chứng minh hành
vi phải viết test capture `Specification` rồi kiểm tra predicate thật.

**Quy tắc:** với logic điều kiện, phải kiểm tra **hành vi**, không chỉ build.

### 3.2 Test có thể fail sẵn từ trước — không phải do mình

`tests/config-release.test.mjs` fail ở assertion dòng 18. Tôi suýt tưởng do
mình gây ra.

**Cách kiểm tra:** revert thay đổi của mình rồi chạy lại:
```powershell
git stash push -- <file>
node --test tests/...
git stash pop
```
Nếu vẫn fail → lỗi tiền tồn, báo cáo riêng, đừng sửa lẫn.

Nguyên nhân thật: `prepare-release.mjs:116` xoá mọi `add_header Access-Control-`,
rồi dòng 140-141 **chèn lại** cho route `/api/v1/matching/` — mâu thuẫn với
assertion. Chưa sửa.

### 3.3 Test mới viết có thể sai, không phải code sai

`OpportunityQueryServiceAdminFilterTest` fail lần đầu vì mock tích luỹ giữa
các vòng lặp — lỗi **của test**, không phải của fix. Sửa bằng
`clearInvocations(criteriaBuilder, opportunityRepository)`.

**Quy tắc:** khi test fail, xác định lỗi nằm ở test hay ở code trước khi sửa code.

### 3.4 Đối chiếu kiểu constructor trước khi viết test

Tôi viết `new NoResourceFoundException(null, path)` — sai kiểu. Signature thật
là `(HttpMethod, String)`. Cách kiểm tra nhanh khi không có `javap`: giải mã
constant pool của file `.class` trong jar để tìm descriptor `(...)V`.

---

## 4. Bẫy trong codebase EduMatch

### 4.1 `ProtectedRoute.tsx` là file RỖNG 0 byte

Tên gợi ý có route guard nhưng file trống. Việc gate thật nằm ở
`src/middleware.ts`.

Cùng nhóm file rỗng khác (không được import ở đâu):
`AuthDebug.tsx`, `lib/debug-auth.ts`, `ui/dropdown-menu.tsx`,
`ui/scroll-area.tsx`, `hooks/index.ts`.

**Đừng tin tên file — kiểm tra nội dung.**

### 4.2 UI admin gửi `'all'` chữ thường, không phải `'ALL'`

`app/admin/scholarships/page.tsx` map `'all'` → `undefined` và **bỏ** parameter.
`services/admin.service.ts:529` đã có check `!== 'ALL'` cho caller khác.

Nên bug `status=ALL` trả 0 dòng là **rủi ro tiềm ẩn**, không phải lỗi UI đang gặp.

### 4.3 PowerShell không đọc được đường dẫn có `[vuông]`

`src/app/admin/users/[id]/page.tsx` báo "0 dòng / không tồn tại" — thực ra có
349 dòng. Phải dùng `-LiteralPath`:
```powershell
Get-Content -LiteralPath 'src\app\admin\users\[id]\page.tsx'
```
Tôi đã suýt báo sai 5 file là rỗng.

### 4.4 File dùng CRLF

`nginx.local.conf` có `\r\n`. `grep "location /api/ {"` không khớp trên host dù
file có dòng đó. `prepare-release.mjs:112` chuẩn hoá `\r\n` → `\n` trước khi xử lý.

---

## 4b. Deploy ảnh mới — chuỗi quyền hạn (đã vấp 2026-10-08)

### Instance build được nhưng KHÔNG push được ECR

Instance role chỉ có `ecr:BatchGetImage` + `GetDownloadUrlForLayer` —
**không có** `InitiateLayerUpload`/`PutImage`. Build trên instance rồi
`docker push` sẽ fail 403. Đây là thiết kế tối thiểu quyền, đừng sửa IAM.

Máy Windows local **không có Docker** (Docker Desktop không chạy được).

**Đường đi đúng đã dùng được:**
1. Build trên instance (`/opt/edumatch/build/edumatch`)
2. `docker save | gzip` → `aws s3 cp` vào prefix **`status/`** (instance chỉ
   `PutObject` được ở `status/*`; `releases/*` chỉ `GetObject`)
3. `aws s3 cp` tải về Windows
4. **WSL Ubuntu có Docker thật** (`wsl -d Ubuntu -- docker ...`) → load → push ECR
5. Lấy ECR token trên Windows: `aws ecr get-login-password | Out-File`
   rồi WSL đọc qua `/mnt/c/...`

**Bẫy:** `Out-File -Encoding utf8` của pwsh 7 thêm **BOM** → `JSON.parse` fail.
Dùng `[IO.File]::WriteAllText($p, $s, [Text.UTF8Encoding]::new($false))`.

### Guard đòi label revision khớp cho CẢ 6 image

`release.sh` so `org.opencontainers.image.revision` của từng image với
`sourceRevision` trong manifest. Build lại 1 service thôi là đủ để fail
`Source label mismatch`.

**Và label phải là FULL 40-char SHA**, không phải short SHA. Tôi đã build
với `--label ...=5d65c88` → guard báo mismatch dù image đúng.

Lần sau: build **cả 6** image với `org.opencontainers.image.revision=$FULL_SHA`.

### Tag ECR là IMMUTABLE

Push lại cùng tag → `tag invalid: ... cannot be overwritten`. Dùng tag mới
(`-2`) hoặc chấp nhận digest cũ đã đúng.

### `/opt/edumatch/current` phải là symlink, không phải thư mục

`cat: /opt/edumatch/current: Is a directory` → guard không đọc được release
trước. Sửa: `rm -rf /opt/edumatch/current; ln -sfn /opt/edumatch/releases/<id> /opt/edumatch/current`

---

## 4c. Load test — bài học đo lường (2026-10-08)

### Phải pace dưới rate limit, nếu không đo nhầm nginx

Chạy không pace ở c=1 cho ra **40% lỗi 429** và p50 1.9ms — con số đó mô tả
**trần `api_limit` 100r/s của nginx**, không phải khả năng ứng dụng.

Cách đúng: đặt offered load dưới ngưỡng, **chỉ tính 429/5xx là lỗi**, và chỉ
đưa request được phục vụ vào percentile latency.

### Load generator phải ở máy riêng

Chạy generator trên cùng instance sẽ tranh CPU với app (instance chỉ
**2 vCPU**). Dùng EC2 riêng (t3.small) cùng VPC, thêm SG rule cho phép vào 443,
gọi qua private IP `10.42.0.14`.

Cert self-signed chỉ có SAN `edumatch.staging.local` — **không có IP**. Nên
phải thêm `/etc/hosts` trên generator trỏ hostname về IP private, và dùng `-k`.

### Quoting: viết script ra file, đừng nhồi vào `--parameters`

Nhồi script phức tạp vào `aws ssm send-command --parameters` qua pwsh rất dễ
hỏng (`$VAR` bị PowerShell nuốt, heredoc không chạy). Cách chắc chắn:
base64 nội dung script → `base64 -d` trên host → `bash /tmp/x.sh`.
Payload >64KB thì SSM từ chối → đẩy qua S3 `releases/`.

### `wsl -d Ubuntu -- bash -c "..."` cũng bị PowerShell phá quoting

Cùng lý do. Viết `.sh` ra file, `wsl -d Ubuntu -- bash /mnt/c/.../x.sh`.

### `/tmp` trên instance là EPHEMERAL — đẩy kết quả ra ngoài NGAY

**Đã mất dữ liệu soak 30 phút vì lỗi này (2026-10-08).** Sampler ghi vào
`/tmp/soak-samples.csv`. AWS session hết hạn, instance bị stop, `/tmp` mất sạch.
Không còn cách nào biết soak có sạch hay không.

**Quy tắc:** kết quả đo phải được **stream ra ngoài trong lúc chạy**, không để
đến cuối:
- `aws s3 cp` định kỳ (mỗi 5 phút) vào prefix `status/`, hoặc
- ghi thẳng lên CloudWatch Logs, hoặc
- `tee` sang một chỗ bền vững

Với test dài (soak), **không bao giờ** chỉ để kết quả trong `/tmp` của instance.

### AWS session hết hạn giữa test dài

Session chết lúc 19:47Z giữa soak. Hệ quả: mất quyền truy cập **và** mất luôn
khả năng đọc kết quả đang ghi dở.

**Trước phiên test dài:**
- kiểm tra token còn hạn bao lâu
- chuẩn bị đường đọc kết quả **không phụ thuộc** việc session còn sống
- biết trước instance sẽ bị stop thế nào và dữ liệu đi đâu

### Đừng kết luận từ một lần chạy — và đừng nhầm "không tái hiện" với "bác bỏ"

Lần load test đầu: scholarship-service `166% CPU` + `161 Communications link
failure`. Lần hai **không tái hiện** → tôi suýt viết "bác bỏ giả thuyết CPU".

**Sai.** Hai lần chạy **không tương đương**: lần hai có 63/400 request bị 429
chặn ở nginx (app nhận **ít tải hơn**), stack vừa boot (cache/JIT khác), thời
lượng khác. Muốn so sánh phải giữ **cùng RPS thực tế tới app** — đo, không
giả định.

**Quy tắc:** "không tái hiện được" chỉ nói lên đúng một điều: lần đó không
tái hiện. Không bác bỏ, không xác nhận.

### Đọc 2 file properties KHÔNG đủ để kết luận về config

Tôi grep 2 file, thấy không có Hikari → kết luận "loại eviction". Sai:
chưa kiểm tra **profile đang active**, **biến môi trường**, **cấu hình bằng
code** (`HikariConfig` bean, `DataSourceBuilder`).

Và `maxLifetime=30 phút` **không đảm bảo** connection sống 30 phút — MySQL
`wait_timeout` hoặc thiết bị mạng có thể đóng trước. Hikari khuyến nghị đặt
lifetime **thấp hơn** giới hạn hạ tầng.

### Dữ kiện "nghe hợp lý" vẫn có thể vô nghĩa

Tôi từng viết "port nguồn khác nhau → connection churn". **Sai**: connection
pool giữ nhiều connection, mỗi cái có port riêng. Đó là trạng thái **bình
thường**, không chứng minh gì.

Trước khi dùng một dữ kiện làm bằng chứng, hỏi: *nếu giả thuyết tôi đúng thì
phải thấy gì, và nếu tôi sai thì có thấy y hệt thế không?* Nếu cả hai đều cho
cùng kết quả thì dữ kiện đó vô giá trị.

### Đo tổng thời gian không suy ra được thành phần

`/api/user/me` mất 114ms **tổng** (connect + gửi + chờ + đọc). Không cho biết
riêng **connect** mất bao lâu. Tôi đã đề xuất tăng `connectTimeout` 500ms→2s
từ con số đó → **không có căn cứ**. Tăng timeout còn làm request giữ tài
nguyên lâu hơn khi downstream hỏng.

Muốn đề xuất timeout thì phải **đo riêng connect và read**.

### Đánh giá tải phải xét latency VÀ error rate cùng lúc

Tôi viết "pass tới c=50" trong khi `detail` p95 = **319ms > 300ms target** và
tỷ lệ lỗi **57-61%**. Chỉ nhìn một chỉ số là sai.

Và đếm lỗi phải bao gồm **timeout, lỗi mạng, response 200 sai nội dung** —
không chỉ 429/5xx.

### Đừng nói "mọi latency vô nghĩa" khi bị rate limit

Câu đó quá tuyệt đối. Số đo khi bị 429 **vẫn mô tả hành vi của hệ thống có
rate limit** — hữu ích cho việc khác. Nó chỉ **không đủ** để kết luận sức chịu
tải backend.

Cách đúng: **tách response thành công / 429 / lỗi khác**, rồi nói rõ kết luận
nào rút ra từ nhóm nào.

### KHÔNG cộng `heap_max` với `nonheap_used` rồi gọi là "RAM đang dùng"

Tôi đã làm đúng lỗi này **một giờ sau khi vừa học được nó**. `heap_max` là
**trần cấu hình**; `nonheap_used` là **lượng đang dùng**. Hai đại lượng khác
bản chất, không cộng được.

Phép cộng đó chỉ **gợi ý ngân sách memory có thể thiếu**. Muốn kết luận phải
đo **`memory.current` / `memory.max`** của **cgroup từng service**.

### Cùng concurrency KHÔNG có nghĩa cùng tải

Tôi từng bắt hai lượt phải có "cùng RPS thành công" để so sánh. **Sai logic:**
RPS thành công **chính là kết quả cần so sánh** — bắt nó bằng nhau là giả định
trước điều cần chứng minh.

Đúng cách: **chốt cùng tải ĐƯA VÀO** (target RPS hoặc concurrency, tuỳ mục
đích bài test), rồi **đo** tải thực tế, request bị chặn, và throughput thành
công. Concurrency bằng nhau vẫn cho RPS khác nhau khi hệ thống nhanh hơn.

### Điều kiện kiểm chứng phải ĐO ĐƯỢC

Đừng viết "memory còn khoảng trống" hay "GC không bất thường" — vô nghĩa vì
không ai kiểm chứng được. Phải có ngưỡng cụ thể.

- `oom_kill` phải **không TĂNG trong cửa sổ test** (đo **delta**), không phải
  "tổng lịch sử = 0" — container có thể đã restart từ trước vì lý do khác.
- Cùng vậy với `RestartCount`: so **delta**, không so giá trị tuyệt đối.
- Theo dõi **tổng memory cgroup** (`memory.current` + `memory.stat`
  anon/file/kernel), **không** chỉ heap hay RSS của Java — cgroup limit rộng
  hơn tiến trình Java.

### Một log kernel ĐỦ để chứng minh MỘT sự kiện

Đừng nghĩ "chạy 2 lượt + soak 30 phút" mới là bằng chứng. Một dòng `dmesg`
ghi rõ cgroup scope + PID bị kill là **đủ** để khẳng định **một sự kiện OOM đã
xảy ra**.

Chạy lặp chứng minh **tính ổn định**. Soak tìm **dấu hiệu xuống cấp trong
khoảng đã chạy**. Không cái nào chứng minh "hết lỗi".

**Quy tắc dùng từ:** không đổi *"chưa thấy leak"* thành *"không có leak"*.
Không đổi *"qua 2 lượt + soak"* thành *"đã loại trừ nhóm lỗi này"*.

### Kiểm tra giả thuyết bằng cách loại trừ rẻ nhất trước

- Nghi Hikari evict → grep config (nhưng phải grep **đủ**: profile, env, code)
- Nghi memory leak → đo idle vs sau tải (nhưng phải đo **heap sau GC**, không
  chỉ tổng container memory)
- Nghi CPU → phải tái hiện ở **cùng mức tải thực tế**

Đọc code/config để loại giả thuyết **trước khi** bật máy tốn tiền — nhưng
đừng biến việc loại trừ sơ sài thành kết luận chắc chắn.

---

## 5b. NGUYÊN NHÂN GỐC ĐÃ TÌM RA: OOM-kill (2026-10-08)

**`scholarship-service` bị kernel OOM-kill dưới tải.** Bằng chứng `dmesg`:

```
Memory cgroup out of memory: Killed process 3482 (java) anon-rss:403736kB
Memory cgroup out of memory: Killed process 24268 (java) anon-rss:402844kB
```

`anon-rss` 394 MiB chạm trần cgroup 400 MiB → JVM chết → nginx mất upstream →
**2435 lỗi 502** cho client → JVM restart mất **16.5s**.

### Ngân sách memory có thể thiếu — nhưng phải ĐO mới kết luận

`MaxRAMPercentage=70.0` tính heap từ cgroup limit và **bỏ qua non-heap**. Với
scholarship (limit 400 MiB): 70% = 280 MiB heap, cộng non-heap đo được ~150 MiB
là ~430 MiB — **vượt trần**. Đó là lý do nó bị OOM-kill, và
`-Xmx256m -XX:MaxMetaspaceSize=192m` thay thế đã sửa được.

**CẢNH BÁO — bẫy tôi đã sẫm:**
Đừng lập bảng kiểu `heap_max + nonheap_used` cho từng service rồi gọi đó là
"RAM đang dùng" và xếp hạng service nào nguy hiểm. `heap_max` là **trần cấu
hình**, `nonheap_used` là **lượng đang dùng** — hai đại lượng khác bản chất.

Phép cộng đó chỉ **gợi ý ngân sách có thể thiếu**. Muốn xếp hạng phải đo
**`memory.current` / `memory.max`** của cgroup **từng service** dưới tải.

**Trạng thái thật:**
- `scholarship-service`: **đã chẩn đoán** (dmesg + RestartCount + restart
  signature) → **đã sửa** → **đã verify** dưới workload tái hiện lỗi.
- `auth-service`, `chat-service`: **CHƯA chẩn đoán**. Không có dmesg, không
  restart, chưa load test riêng. **Không kết luận gì được.**

### Ba chỉ số ĐÁNH LỪA tôi (ghi để không lặp lại)

1. **`OOMKilled: false`** — Docker chỉ set cờ này cho container **hiện tại**.
   Sau restart cờ reset về false. **Không phát hiện được kill trong quá khứ.**
   Tín hiệu đúng: `RestartCount` + `dmesg` + `oom_memcg`.
2. **Heap chỉ 66.8/283.8 MB (24%)** — heap **không phải** toàn bộ JVM.
   `anon-rss` gồm metaspace, code cache, thread stack, direct buffer.
   Cgroup limit áp lên **tổng RSS**, không phải heap.
3. **`OOMKilled=false` + heap thấp ⇒ "memory không phải vấn đề"** — kết luận
   này tôi đã đưa ra **2 lần**, cả hai đều sai.

### Cách chẩn đoán đúng

```bash
dmesg -T | grep -i "oom\|killed process"      # bằng chứng kernel
docker inspect <c> --format '{{.RestartCount}}'
docker inspect <c> --format '{{.State.OOMKilled}}'   # CHỈ nói về hiện tại
# theo dõi anon-rss, KHÔNG phải heap:
grep '^anon ' /sys/fs/cgroup/memory.stat
```

### Hikari và MySQL — đã loại bằng ĐO, không phải suy luận

- Hikari (đọc từ `/actuator/metrics` với admin token, **401 nếu không có token**):
  max=10, idle=10, pending=0, **timeout=0** suốt run → pool chưa bao giờ cạn.
- MySQL: `wait_timeout=28800s` (8 giờ) → không phải idle timeout đóng connection.
- CPU cao lúc lỗi là **hệ quả của restart**, không phải nguyên nhân.

### Bài học phương pháp

Lần này tôi chạy **sampler đồng bộ theo epoch** cùng lúc với load, và nó phát
hiện restart qua dấu hiệu trong-băng: `http.server.requests` reset **5643 → 10**,
`gc_count` **58 → 2**. Đó là cách phát hiện restart mà **không cần** đọc dmesg.

**Và:** phải đảm bảo app **thật sự nhận tải**. Run này có **0 lỗi 429**
(`effectiveRpsToApp=59.5`), nên so sánh được. Run "không tái hiện" trước đó có
63/400 bị 429 — app nhận ít tải hơn, nên **không so sánh được**.

---

## 5c. Outbox publisher — ĐÃ SỬA (2026-10-09, commit d988762)

**ĐÍNH CHÍNH kết luận cũ.** Tôi từng kết luận "mọi event không bao giờ tới
broker". **SAI.** Đối chiếu `event_id` giữa outbox / `processed_events` / queue
cho thấy **4/9 event ĐÃ được consumer xử lý** trong khi row outbox vẫn ghi
FAILED. Publish **thành công**, chỉ **confirm** không nhận được.

**Nguyên nhân:** `OutboxPublisher` chờ `CorrelationData.getFuture().get(5s)`,
nhưng `RabbitMQConfig` tạo `new RabbitTemplate(cf)` **không bật publisher
confirms** → future không bao giờ complete → `TimeoutException` →
`getMessage()` null → `last_error=NULL`.

**Sửa:**
- `RabbitMQConfig`: `setMandatory(true)` + `setConfirmCallback` (log ack/nack với
  cause) + `setReturnsCallback` (log unroutable với replyCode/replyText)
- `application.properties`: `publisher-confirm-type=correlated`,
  `publisher-returns=true`
- `OutboxPublisher.markFailed`: ghi **tên exception class**, và **unwrap
  `ExecutionException`/`CompletionException`** trước khi test `TimeoutException`
  — vì confirm wait bọc timeout trong `ExecutionException`
- Test: cập nhật assertion cũ + thêm test drive confirm timeout

**Verify live:** tạo opp qua API → outbox `PUBLISHED` `attempts=0`, log có
`Published outbox event`, consumer nhận `processed_events=1`. Replay event cũ
giữ `event_id` → PUBLISHED, **dedup giữ** (không nhân bản row).
**Cuối: 17 PUBLISHED, 0 FAILED, DLQ 0.**

### Bài học phương pháp (quan trọng nhất phiên này)

**Phải đối chiếu `event_id` ở consumer TRƯỚC KHI kết luận "message chưa gửi".**
Tôi kết luận từ tín hiệu gián tiếp (`last_error=NULL`, log "publish failed")
mà không hỏi "consumer có nhận được không?". Một truy vấn
`SELECT COUNT(*) FROM processed_events WHERE event_id=...` đã lật ngược kết luận.

`last_error=NULL` là dấu hiệu `TimeoutException` **bọc trong
`ExecutionException`**, không phải lỗi AMQP. Khi ghi diagnostic, **unwrap**
exception chain trước khi phân loại.

---

## 5c-bis. Điều kiện nộp đơn — đọc code, đừng đoán (2026-10-09)

`ApplicationService.validateOpportunityEligibility` yêu cầu: `isPublic`,
`moderationStatus=APPROVED`, `applicationDeadline` không null và **không ở quá
khứ**. **`startDate` KHÔNG tham gia.**

Và API **từ chối** `applicationDeadline` **sau** `startDate`
(`deadlineBeforeStart`). Nên fixture "đang mở" phải là: deadline tương lai +
startDate **sau** deadline. Đặt startDate quá khứ + deadline tương lai sẽ bị
400.

`GET /api/v1/me/applications` sort theo **`id ASC`** → row mới nhất (id cao
nhất) nằm ở **trang cuối**. Với seed 30k applications, row mới ở trang 833/834.
Đừng tưởng "không thấy trong list" là bug.

---

## 5d. Rate limit — phải tra zone TRƯỚC khi đo (2026-10-09)

Tôi chạy benchmark matching với 60-80 r/s và nhận **96% lỗi 429**. Run đó
**KHÔNG HỢP LỆ** làm phép đo năng lực.

Zone thật trong nginx:

| Route | Zone | Rate |
|---|---|---|
| `/api/v1/match` | `api_limit` | **100 r/s** |
| `/api/v1/recommendations` | `ml_limit` | **5 r/s**, burst=3 |
| `/api/v1/matching/` | `api_limit` | 100 r/s |

Đo thực tế: `/api/v1/match` 20 request liên tiếp → **20×200, 0×429**.
`/api/v1/recommendations` ở 4 r/s → **7×200, 13×429** (bucket tính theo
`$binary_remote_addr` nên một IP chia sẻ).

**Quy tắc:** trước khi đo endpoint nào, `grep limit_req` zone của route đó và
đặt offered load **thấp hơn** ngưỡng. Nếu thấy 429 đáng kể thì run đó là phép
đo rate limiter, không phải ứng dụng.

---

## 5e. `score=0.0` có thể là ĐÚNG, không phải bug (2026-10-09)

`POST /api/v1/match/score` trả `0.0` cho mọi cặp tôi thử → tôi tưởng bug.
Không phải. Response đầy đủ nói rõ:

```json
{"overallScore":0.0, "hardFiltersPassed":false,
 "constraintViolations":["degree_mismatch"],
 "explanations":["Rejected by hard filter: degree_mismatch"]}
```

Applicant 1001 là `UNDERGRADUATE`, opp 50008 là `BACHELORS` → **hard filter
chặn đúng**. Đổi sang cặp khớp (`opp 1001` cũng `UNDERGRADUATE`) → **50.24**,
`hardFiltersPassed=true`.

**Quy tắc:** khi thấy giá trị 0/rỗng, **đọc toàn bộ response body** trước khi
kết luận. Các trường như `hardFiltersPassed`, `constraintViolations`,
`explanations` giải thích lý do.

Và: `applicant_features` chỉ có **3/10** row có gpa/level — phải kiểm tra dữ
liệu đầu vào trước khi đo.

---

## 5f. Frontend journey — chạy được, và 3 bẫy test (2026-10-09)

**Cách chạy Playwright khi workstation không tới được staging:**

Host không có chromium/node, `dnf` không có package chromium, và
`session-manager-plugin` không tồn tại nên không tạo được SSM port-forward.

Cách đã dùng được:
1. `docker pull mcr.microsoft.com/playwright:v1.49.0-noble` (2.5GB, có browser)
2. Image **không chứa package npm `playwright`** → gửi `playwright-core` (7.6MB)
   từ `node_modules` của harness lên, mount vào container
3. `chromium.launch({ executablePath: '/ms-playwright/chromium-1148/chrome-linux/chrome' })`
4. `--network host` + thêm `/etc/hosts` trỏ `127.0.0.1 edumatch.staging.local`
   — nginx là container riêng sau `docker-proxy`, nên `--add-host :127.0.0.1`
   trong network thường **không** tới được
5. `waitUntil: 'domcontentloaded'` chứ **không** `networkidle` — app giữ
   WebSocket/keepalive nên `networkidle` không bao giờ settle

### Ba bẫy làm tôi báo FAIL sai

**1. Login dùng EMAIL, không phải username.** `validateForm` kiểm regex email;
điền `student1` → chặn ở client, **0 API call**. Phải dùng
`student1@edumatch.dev`. Backend thì chấp nhận cả hai
(`AuthService.authenticateUser`, biến `usernameOrEmail`) — **bất nhất quán giữa
hai tầng**, ghi nhận là finding.

**2. Selector phải lấy từ DOM thật.** Login form **không có `name`/`id`**, chỉ
có `type="email"`/`type="password"` và `placeholder`. Ô search ở trang
scholarships dùng `placeholder="Search scholarships by name, field, or keyword..."`
chứ không phải `type="text"`.

**3. `/user/scholarships` CÔNG KHAI có chủ đích.** `middleware.ts` có
`publicScholarshipRoutes` để cho phép duyệt học bổng. Đừng báo đây là lỗi guard.
4/5 route `/user/*` còn lại đều chặn đúng.

### Kết quả thật

**Rerun 2026-10-11: 10/10 PASS**, mỗi bước có điều kiện + output cụ thể.
Chi tiết: `artifacts/JOURNEY-RERUN-2026-10-11.json`.

**Phân loại trạng thái — đừng đổi FAIL thành PASS bằng lời giải thích:**
- `PASS` = assertion chạy và điều kiện đúng
- `FAIL` = assertion chạy và điều kiện **không** đúng
- `TEST ERROR` = harness **không thực hiện được** phép kiểm (selector sai, timeout)
- `UNVERIFIED` = chưa chạy lại

**3 "FAIL" lần trước là TEST ERROR, không phải lỗi sản phẩm:**
- Bước 5: đếm `button:has-text("Apply Now")` → **0 nút** vì account đã apply,
  nút thật là **"Applied"**. Marker thật: `a[href*="/scholarships/"]` (12 cái).
- Bước 6: tìm `input[type=text]`; control thật dùng
  `placeholder="Search scholarships by name, field, or keyword..."`
- Bước 9: assertion đòi **mọi** `/user/*` phải chặn, nhưng `middleware.ts` khai
  báo `publicScholarshipRoutes` chứa `/user/scholarships`. **Assertion sai**,
  không phải sản phẩm sai.

### Chuỗi 401/refresh/RSC — đã điều tra, KHÔNG phải lỗi phiên

Đo trực tiếp, không suy luận:
- `POST /api/auth/refresh` **không cookie** → **401** `"Refresh token is missing"`
- `POST /api/auth/refresh` **có cookie** → **200** + token rotate
- Log auth-service: **5 lần** `Access token refreshed and refresh token rotated
  for user: student1` liên tiếp thành công

**Nguyên nhân 401 đầu tiên:** cold start — refresh chạy khi browser context
**chưa có cookie**. `AuthController.getRefreshTokenFromCookie` trả null → 401
theo thiết kế. Mọi refresh sau login đều 200.

**17 RSC abort lần trước là artefact của harness:** tôi gọi `clearCookies()` rồi
điều hướng → Next.js prefetch RSC khi chưa có session. Khi điều hướng lúc đã
đăng nhập → **0 abort**.

Phiên ổn định — được chứng minh độc lập bằng bước 3 (`/api/auth/me` 200 ba lần)
và bước 4 (render tên user).

**Quan sát riêng:** `refresh_token = 9` active, `revoked_refresh_tokens = 468`.
Rotation đúng thiết kế nhưng bảng revoked **tăng vô hạn**, không thấy retention.

---

## 5. Kiến trúc & hạ tầng — sự thật đã kiểm chứng

### 5.1 Target staging

| Thông số | Giá trị |
|---|---|
| Account | `741269129377` |
| Region | `ap-southeast-1` |
| Instance | `i-019a0c2a898eb9800` (m7i-flex.large) |
| Log group | `/edumatch/staging` (retention 7 ngày) |
| Release bucket | `edumatch-staging-releases-741269129377` |
| Domain | `edumatch.staging.local` |
| Session tối đa | 4 giờ |

### 5.2 KHÔNG có monitoring

Đã kiểm tra live: **0 alarm, 0 dashboard, 0 metric filter, 0 subscription
filter, 0 SNS topic** cho EduMatch. Chỉ có log group.

**Hệ quả:** lỗi 500 xảy ra nhưng không ai được báo. Log có ghi, không ai đọc.

**Cảnh báo:** `docs/OBSERVABILITY_RUNBOOK.md` mô tả alert p95/5xx — nhưng đó là
**Azure** (Application Insights, Bicep). Trên AWS **không tồn tại**.
`prepare-release.mjs` còn chủ động xoá `APPLICATIONINSIGHTS_CONNECTION_STRING`.
Đừng tin runbook này về mặt alert.

### 5.3 IAM không cho phép tạo alarm

Policy `infra/bootstrap-iam/policy.json` có 8 service:
`budgets, ec2, ecr, iam, logs, s3, ssm, sts` — **không có `cloudwatch`, `sns`**.
Muốn thêm monitoring phải sửa policy trước.

### 5.4 Terraform state lưu local

`infra/versions.tf` không khai báo `backend`. State ở `infra/terraform.tfstate`,
31 resource. **Backup state trước khi apply**, và chỉ apply từ một máy.

`aws_ebs_volume.data` có `prevent_destroy = true`.

### 5.5 Alarm EC2 kiểu thường sẽ báo động giả

Instance **stop/start theo phiên**. Alarm `StatusCheckFailed` /
`CPUUtilization` sẽ kêu **mỗi lần stop máy** → alarm fatigue.

Chỉ nên alarm trên metric **application-level** (từ log), không phụ thuộc máy sống.

### 5.6 Frontend 35.495 dòng, 0 test

`app/` 17.805 dòng (30 trang role = 15.839 dòng), `components/` 9.379.
Backend thì có test (20 file Java + 5 Python).

Quét trùng lặp bằng khối 6 dòng: **chỉ 1 cặp near-duplicate**
(`ChatWidget` ↔ `MessagingWidget`). Nghĩa là code **không thừa vì copy-paste**,
mà thừa vì **lặp cấu trúc** — 30 trang tự dựng header/table/pagination riêng.

Đừng "xoá phần thừa" — phải refactor, và refactor trên 0 test là rủi ro cao.

---

## 6. Bảo mật — đã kiểm chứng

### Đã làm đúng (đừng phá)
- JWT algorithm pinning tường minh (`claimsFromExpectedAlgorithm`), có `requireIssuer`
- Cookie `HttpOnly` + `SameSite=Lax` + **fail-closed** ở staging/prod
- Upload: magic bytes, từ chối SVG, **re-encode** strip metadata, tên file do server sinh
- Không có credential nào bị commit (`.env`, `*.pem`, `*.key` đều gitignore)
- EBS encrypted, S3 versioning + SSE + public access block

### Cần sửa
- **CORS** `chat-service/config/CorsConfig.java`: `allowCredentials(true)` +
  pattern `https://*.azurecontainerapps.io` + `http://localhost:*` → tin domain
  không kiểm soát được. Chưa xác minh khai thác được không.
- `/api/service/token` là `permitAll` — **chưa đọc** logic bên trong.
- `DebugController` (`/debug/jwt`) và Swagger `permitAll` — không nên có ở prod.
- Spring Boot **3.3.2** lỗi thời, **không có Dependabot/CodeQL** → không ai
  theo dõi CVE.

---

## 7. Quy trình git

- Repo: `hunter875/edumatch-production`, branch làm việc `fix/chat-auth-service-identity`.
- `.git` bị sandbox chặn khi policy là `workspace-write` → cần escalate để commit.
- `scripts/` và `tests/` của DSH **nằm ngoài** repo `edumatch` — không version control ở đó.
- Commit message dài: ghi ra file rồi `git commit -F <file>` (heredoc không chạy trong pwsh).

---

## 8. Việc còn treo (tính đến 2026-10-09, sau phiên 2)

Báo cáo đầy đủ: `artifacts/FINAL-REPORT-v2-2026-10-09.json`

1. **Cache Redis hiệu quả CHƯA chứng minh.** Config đúng
   (`SPRING_CACHE_TYPE=redis`), `keyspace_hits` tăng (0→6) khi drive reads,
   **nhưng `dbsize=0`** và `--scan --pattern 'scholarship:*'` không thấy key nào
   dù đọc list 3 lần liên tiếp. Không quan sát được eviction (0 key trước và
   sau write). Dữ liệu **không stale** (PATCH xong đọc lại đúng). Cần điều tra
   riêng — có thể cách đếm key của tôi gây nhầm.
2. **`auth-service` ở 90.4% trần memory** (463/512 MiB) — cảnh báo, chưa nâng.
3. **Chưa làm:** frontend journey qua browser, mixed 15-phút load, WebSocket
   dưới tải đồng thời, benchmark 100k.
4. `tests/config-release.test.mjs` fail tiền tồn (CORS filter vs re-insert).
5. Monitoring chưa làm (IAM thiếu `cloudwatch`/`sns`).
6. CORS wildcard + `/api/service/token` chưa xác minh.
7. Chỉ **3/10** applicant có feature đầy đủ.

### Đã sửa và verify

- **BUG-1 outbox publisher** — commit `d988762`, 17 PUBLISHED / 0 FAILED.
- **BUG-2 OOM scholarship-service** — release `-2`.
- **BUG-3 OOM scholarship-db** — release `-3` (limits 768M).
- **BUG-4** 405 + status=ALL + nginx JSON 404 — release `-1`.
- **Application happy path** — đã quan sát 201 CREATED (fixture 60004, app 530001).
- **Auth lifecycle** login/refresh/logout — PASS.

### Release cuối trên staging

`3977e79b5a43e5a5af628243ab82689940079c61-4` (outbox fix)

### Bằng chứng đã lưu

- S3: `status/evidence/edumatch-perf-2026-10-09.tar.gz` (phiên 1)
- S3: `status/evidence/edumatch-perf-v2-2026-10-09.tar.gz` (phiên 2)
- EBS: `/srv/edumatch/loadtests/`

1. **PR #11 chưa merge** — 3 fix (`5d65c88`, `5b662e8`, `3977e79`) đã có CI xanh.
2. **3 fix ĐÃ deploy lên staging** (release `3977e79b...-1`) và đã verify live.
3. **OOM `scholarship-service` — đã chẩn đoán, đã sửa, đã verify.** Kernel
   OOM-kill, không phải CPU/Hikari/DB. Fix: limit 400M→768M,
   `MaxRAMPercentage=70` → `-Xmx256m -Xss512k -XX:MaxMetaspaceSize=192m`.
   Deploy release `3977e79b...-2`. 2 lượt chạy: **0 lỗi 502** (trước 2435),
   `oom_kill` delta = 0, `RestartCount` delta = 0.
   Chi tiết: `artifacts/rootcause-oom-2026-10-08.json`.
   **Soak 30 phút: KHÔNG CÓ BẰNG CHỨNG.** Sampler có thể đã chạy đủ (đặt 1900s
   từ 19:45:28Z, kết thúc ~20:17Z) nhưng dữ liệu nằm trong `/tmp` và **mất khi
   instance stop**. Mẫu cuối xác nhận được chỉ là 19:46:23Z (55 giây). Phải
   chạy lại, lần này **stream kết quả lên S3 trong lúc chạy**.
4. **`auth-service` và `chat-service`: CHƯA chẩn đoán memory.** Có cùng
   `MaxRAMPercentage=70.0` và limit 400-512M, **nhưng chưa đo
   `memory.current`/`memory.max` riêng, chưa load test riêng, không có dmesg.**
   Không được kết luận hai service này thiếu RAM. Xem cảnh báo ở mục 5b.
5. **161 lỗi JDBC ở lần chạy đầu: CHƯA XÁC MINH** có liên quan OOM hay không.
   Cần đối chiếu timestamp log JDBC với timestamp OOM. Chưa làm.
6. `tests/config-release.test.mjs` fail tiền tồn (CORS filter vs re-insert).
7. Monitoring chưa làm (IAM thiếu `cloudwatch`/`sns`).
8. CORS wildcard + `/api/service/token` chưa xác minh.
9. Load test mới chạy trên seed 7 bản ghi — **chưa test ở 10k/100k** như
   tài liệu benchmark mô tả.
