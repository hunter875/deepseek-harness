# EduMatch DeepSeek Harness

Mã nguồn harness, fixture, bài kiểm tra và công cụ vận hành AWS staging cho EduMatch. Thiết kế gốc ở [Spec v3](deepseek-harness-edumatch-aws-spec-v3.md); các bài học vận hành được ghi trong [AGENTS.md](AGENTS.md). Đây là repo riêng của harness: checkout `edumatch/` và `upstream/`, credential, Terraform state, phiên chạy và evidence trong `artifacts/` chỉ giữ trên máy local.

`.env.example` là mẫu cấu hình không chứa credential. Sao chép thành `.env` rồi điền các giá trị của môi trường mình; không commit `.env`. Các báo cáo như `phase-report.md` và `artifacts/phase-status.json` được sinh tại máy chạy và không nằm trong Git.

## Dùng trên máy này

Yêu cầu Node 22.20+; Docker Engine trên Linux/WSL2 cho các bài test container; Terraform 1.16.1 nếu dùng IaC. Dependency upstream được pin trong `package-lock.json`; checkout nguồn `upstream/` dùng riêng để audit. Clone EduMatch vào `edumatch/` khi cần kiểm tra hoặc tích hợp với ứng dụng.

```powershell
Copy-Item .env.example .env
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run doctor
npm run profile
node scripts/protocol-smoke.mjs
node scripts/isolation.mjs
node scripts/demo.mjs --docker
node scripts/engine-fixtures.mjs
npm run eval
```

`prepare-images.mjs` chỉ dùng khi chuẩn bị image: tải tag, ghi digest vào `config/fixture-images.lock.json`. Runner dùng digest đã có với `--pull never`. Isolation proof có hạn 24 giờ, phải chạy lại trên đúng máy và image. Demo sửa một lỗi clamp **tổng hợp**, gồm baseline thất bại và candidate qua ba boundary assertions; đó không phải luật chấm điểm EduMatch.

Tính đến 2026-10-11, `npm test` chạy 32 bài: 31 pass, 1 fail tại `tests/config-release.test.mjs:18`. Assertion này mâu thuẫn với logic chèn lại CORS header của `scripts/prepare-release.mjs`; [AGENTS.md](AGENTS.md) ghi lại cách đã xác minh lỗi tiền tồn. Không xem lần chạy test này là toàn bộ pass.

`npm run broker` mở broker fixture ở loopback. MCP chỉ nhận tool ID/tham số đã duyệt; không nhận SQL/URL/shell tự do. Live mode còn khóa bởi policy, isolation proof và target binding. Tài khoản quan sát DB có column SELECT; RabbitMQ chỉ xem metadata; Redis chỉ TYPE/PTTL/STRLEN/HLEN trên namespace đã xác minh. Engine fixture tạo network nội bộ và dữ liệu giả, rồi dọn đúng container của lượt chạy.

GitHub proxy dùng official MCP server trong container riêng, read-only và không mount host. Điền token read đã audit, pin `ghcr.io/github/github-mcp-server@sha256:...`, rồi bật hai field `GITHUB_*_VERIFIED/ENABLED` tương ứng và sinh lại profile. Proxy chỉ nhận tool đọc đã nhận diện với owner/repo cố định; tool selection không thay thế quyền của fine-grained token. Chưa chạy live smoke nên giữ disabled mặc định. Local log adapter chỉ đọc JSONL từ `targets.localLogFiles` đã chốt; dòng không parse được hoặc tail bị cắt làm evidence partial.

## Coding với DeepSeek thật

Điền `DEEPSEEK_API_KEY`, xác minh giá trên trang chính thức và điền hai `DEEPSEEK_*_PRICE_CEILING_PER_M` cùng `DEEPSEEK_PRICE_VERIFIED_AT` UTC. Giá phải là mức trần bao phủ mọi khung giờ/cache áp dụng. Chưa xác minh được giá thì gateway chặn trước khi gọi API. API có ngân sách riêng 5 USD, không nằm trong dự toán AWS.

```powershell
node scripts/run-task.mjs <task.json> <frozen-verifiers.json> <source-workspace>
```

Contract phải FROZEN và đúng `schemas/task.json`; acceptance, oracle và registry do trusted builder chốt trước khi agent sửa. Driver hiện hỗ trợ task code fixture với verifier Node export, không phải một runner tổng quát cho mọi Maven/Python task. Nó copy source sang workspace riêng, gửi model capability token cục bộ thay cho API key, giới hạn thời gian/calls/token/chi phí bằng transport gateway, rồi tự kiểm tra snapshot ngoài lượt model. Chỉ verdict có chữ ký runner được dùng. Checkpoint giữ task, workspace digest, authority và ngân sách; context thay đổi thì resume bị chặn. Code gốc được giữ nguyên.

Eval hiện có 12 nhóm tình huống tổng hợp, split development/holdout, 3 repetitions và 72 trajectory paired. Nó kiểm tra classifier/reporting với oracle độc lập; **chưa đo độ chính xác của agent DeepSeek**. Eval model thật còn cần key, task EduMatch và business oracle đã chốt. Không chọn profile/model từ kết quả synthetic.

## Staging AWS

Chạy `node scripts/cost.mjs` để tạo dự toán hiện tại trong `artifacts/cost-estimate.json`; không dùng con số trong báo cáo cũ làm giá hiện hành. Kiểm tra trạng thái staging và các lưu ý đã được kiểm chứng trong [AGENTS.md](AGENTS.md) trước khi thao tác. Lưu trữ tiếp tục tính phí khi EC2 stopped; budget alerts không phải hard cap.

1. Tạo named AWS profile và điền account/AMI/CIDR giới hạn, principal observer, budget email, TLS domain trong `.env`. Không đưa root/admin credential cho observer.
2. Kiểm tra OIDC claim thực của hai protected GitHub environments `aws-staging-build` và `aws-staging`; điền provider ARN, exact subject và đánh dấu verified sau khi có evidence. Build/deploy/observer/instance dùng role riêng.
3. Chạy `node scripts/cost.mjs`, `npm run cloud:validate`, `npm run cloud:plan`. Plan không apply. Xem saved plan, ghi quyết định tạo resource cùng `AWS_AUTHORIZATION_REF` trước khi operator apply.
4. IaC tạo VPC public subnet, chỉ HTTPS từ CIDR giới hạn, không NAT/ALB/SSH/public data ports. IMDSv2, encrypted root/data EBS, credits standard, private ECR/S3, CloudWatch retention và budget alerts. OS shutdown làm EC2 **stop**. OIDC deploy role chỉ gọi SSM document release cố định; observer không được gọi SSM/deploy/secret read.
5. Bootstrap host theo `cloud/install.sh`: xác minh UUID của data EBS và Compose binary SHA trước khi cài. Việc format/mount EBS cần đúng volume đã review; script không tự format đĩa. Pin các build/runtime/platform images; chuẩn bị TLS certificate hợp lệ. `runtime-env.mjs` chỉ xuất subset secret cần cho ứng dụng sang `.state/runtime/.env`; operator chuyển subset đó tới `/opt/edumatch/runtime/.env`, mode 0600. Không copy API/AWS/observer credentials vào workload.
6. Tooling đã có installer vào `edumatch/ops/dsh` và workflow AWS riêng. Review/commit/push của bạn mới làm GitHub dùng workflow. Điền GitHub variables có cùng tên `AWS_*`: account/build/deploy role, bucket, instance, domain, hai JSON chứa digest images. Không đưa secret runtime vào workflow artifact.
7. Build chạy kiểm thử nguồn; publish manifest bất biến gồm image/config/migration/source digests. Deploy reconcile đúng image ID/label/revision và health, rồi CI kiểm TLS từ bên ngoài. Trạng thái timeout/không rõ không tự replay. Successful deploy smoke cơ bản chưa chứng minh semantic consumer/cache/outbox; task liên quan cần evidence ở `workflows/references/events-cache.md`.

## Rollback, backup và chi phí

`cloud/release.sh <retained-release-id> rollback` chỉ là **code rollback**. Chỉ cho qua khi migration digest tương thích và current release không drift. Data restore là quyết định riêng; không dùng rollback để che lỗi migration. Manifest/release trước được giữ trong S3 versioned và ECR immutable; chưa có lifecycle tự xóa rollback images.

`backup.sh` khóa deploy, quiesce writer và dump DB vào data EBS mã hóa; `restore-drill.sh` kiểm checksum và restore vào Compose project tạm. Đây là công cụ chuẩn bị: chưa chạy drill/RPO/RTO trên staging, chưa có evidence row counts nghiệp vụ hoặc off-host disaster recovery. Điền RPO/RTO sau khi thống nhất nhu cầu; không tuyên bố staging usable trước khi hoàn thành gate. Lịch max-session chỉ stop host sau giới hạn phiên và tránh chạy trong deploy/backup; cần kiểm thử scope/timer thật sau apply.

Stop EC2 vẫn giữ EBS/snapshot/ECR/S3/log. Trước khi xóa AWS, export manifest/backup và kiểm tra retained restore, xem `terraform plan -destroy`; không tự gỡ `prevent_destroy` hay xóa data. Stop/cleanup là thao tác operator, không nằm trong profile quan sát.

## Gỡ local

Dừng process broker/engine của phiên, xóa profile `edumatch` dưới `.dsh-home/profiles` và các fixture project có tên/ID trong artifact của lượt chạy. Chỉ xóa `.state` khi không cần checkpoint/verdict cũ; mất authority key sẽ khiến chữ ký không xác minh được. Không dùng Docker system prune/global volume prune. `.env` và `.state` không được commit. Muốn gỡ integration, review diff chỉ dưới `ops/dsh` và `.github/workflows/aws-staging.yml`; không xóa workflow Azure đang có.
## Giao diện web

Chạy `npm run ui` để mở server Harness tại `127.0.0.1:3080`. Sau dòng ready, chạy `./Mo-Harness.ps1` để mở URL đăng nhập. Hướng dẫn chi tiết: [HUONG-DAN-GIAO-DIEN.md](./HUONG-DAN-GIAO-DIEN.md).
