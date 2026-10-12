# EduMatch AWS staging — manual session runbook

This runbook covers the **manual** staging path: one operator with a temporary
AWS session drives a single EC2 instance over SSM. It exists because the
GitHub Actions path is still blocked on an unverified OIDC claim, and because
the staging host has no public DNS name or CA-issued certificate yet.

`AWS_DEPLOYMENT_MODE` selects the authorization gate:

| Mode | Account proof | GitHub OIDC claim | Use |
| --- | --- | --- | --- |
| `manual` | required | not asserted | operator session + SSM (this document) |
| `github` | required | required | GitHub Actions build/deploy jobs |

Both modes keep the target-account precondition in `infra/main.tf`. Manual mode
never sets `oidc_claims_verified=true`, so no unverified claim is ever recorded.

## 0. Binding

```txt
Account        741269129377
Region         ap-southeast-1
Instance       edumatch-aws-staging (t3a.large)
Hostname       edumatch.staging.local (self-signed TLS)
Data volume    Terraform aws_ebs_volume.data (encrypted gp3, 30 GB)
App services   auth-service, scholarship-service, chat-service,
               matching-service, matching-consumer, frontend, api-gateway
Platform       auth-db, scholarship-db, chat-db, matching-db, redis, rabbitmq
```

Only TCP 443 is reachable from the allowlisted `/32`; neither SSH nor any
database, Redis or RabbitMQ port is public. All administration goes through SSM.

## 1. Start the instance

```powershell
$env:AWS_REGION = "ap-southeast-1"
$instance = terraform -chdir=infra output -raw instance_id

aws ec2 start-instances --instance-ids $instance
aws ec2 wait instance-running --instance-ids $instance

# SSM registration takes a moment after boot.
do {
  Start-Sleep -Seconds 10
  $ping = aws ssm describe-instance-information `
    --filters "Key=InstanceIds,Values=$instance" `
    --query "InstanceInformationList[0].PingStatus" --output text
} until ($ping -eq "Online")
```

## 2. Connect

The staging host has no public DNS name. Two things make the browser work
against a self-signed certificate:

1. a hosts-file entry pointing the staging hostname at the forwarding socket
2. explicit trust of the exported certificate

Add to `C:\Windows\System32\drivers\etc\hosts` (needs an elevated editor):

```txt
127.0.0.1 edumatch.staging.local
```

Forward local 443 to the instance's 443:

```powershell
aws ssm start-session --target $instance `
  --document-name AWS-StartPortForwardingSession `
  --parameters '{"portNumber":["443"],"localPortNumber":["443"]}'
```

Leave that session open and browse `https://edumatch.staging.local/`.

Fetch the certificate and trust it (run once per certificate rotation):

```powershell
aws ssm send-command --instance-ids $instance `
  --document-name "AWS-RunShellScript" `
  --parameters 'commands=["cat /opt/edumatch/tls/fullchain.pem"]' `
  --query "Command.CommandId" --output text
# Then, with the CommandId printed above:
aws ssm get-command-invocation --command-id <CommandId> --instance-id $instance `
  --query "StandardOutputContent" --output text | Set-Content edumatch-staging.crt

Import-Certificate -FilePath edumatch-staging.crt `
  -CertStoreLocation Cert:\LocalMachine\Root
```

`Import-Certificate` requires an elevated PowerShell. Without it the browser
shows a warning and, more importantly, a `Secure` cookie will not be stored —
so flows that depend on the refresh cookie will look broken.

## 3. Bootstrap the data volume (first boot only)

`bootstrap-data-volume.sh` identifies the Terraform volume by its AWS volume
ID, waits for the attachment, formats **only** a genuinely blank volume,
records the filesystem UUID and writes a UUID-keyed fstab entry. Re-running it
on a populated volume is a no-op.

```powershell
$dataVolume = terraform -chdir=infra output -raw data_volume_id

aws ssm send-command --instance-ids $instance `
  --document-name "AWS-RunShellScript" `
  --parameters "commands=[\"/opt/edumatch/bin/bootstrap-data-volume.sh $dataVolume /srv/edumatch\"]" `
  --query "Command.CommandId" --output text
```

Confirm `DATA_VOLUME_READY` in the command output. `release.sh` refuses to
deploy unless `/srv/edumatch` is mounted from the recorded UUID.

## 3a. Install the reviewed ops bundle

`install.sh` verifies the Compose plugin digest, pins `/srv/edumatch` to the
recorded UUID **and** its AWS volume serial, installs the ops scripts and
enables the auto-stop timer. It refuses to run before the data volume step.

```bash
# On the host, via SSM:
/opt/edumatch/bin/install.sh <reviewed-cloud-dir> <compose-binary> \
  <compose-sha256> <data-volume-id>
```

## 3b. Runtime secrets and TLS

Two operator-provided pieces are required before the first deploy.

Runtime environment — generated locally and pushed as a base64 payload so no
secret appears on a command line or in shell history:

```powershell
pwsh -File scripts/build-runtime-env.ps1
# Writes artifacts/runtime/staging.env plus
# artifacts/runtime/secrets/jwt-public.pem and jwt-private.pem (git-ignored).
```

The RSA keys are mounted as **files** at `/run/secrets`, not passed as
environment variables: a PEM is multi-line and Compose `--env-file` cannot
carry newlines reliably. Every consumer already supports the path form
(`app.jwt.rsa.public-key-path`, `JWT_PUBLIC_KEY_PATH`), and `release_guard.py`
refuses a release that reads a key path without the matching read-only mount.

Self-signed TLS — the host has no public DNS name:

```bash
/opt/edumatch/bin/tls-self-signed.sh edumatch.staging.local
```

## 3c. Auto-stop

`max-session.sh` plus `edumatch-max-session.timer` stop the host after
`max-session-hours` (default 4) measured from each boot, so a stop/start cycle
grants a fresh window. The limit can be changed without editing the script:

1. `/opt/edumatch/max-session-hours` (provisioned from Terraform)
2. `EDUMATCH_MAX_SESSION_HOURS` in `/opt/edumatch/runtime/.env`
3. a numeric first argument (used by the tests)

Values outside 1..12 are rejected rather than guessed. The timer holds the same
deploy lease, so it never interrupts an in-flight deploy or backup.

## 4. Deploy a release

Build images locally, push to ECR, and publish the release objects. Then run
the fixed SSM document — it accepts only a release ID and `deploy`/`rollback`:

```powershell
aws ssm send-command --instance-ids $instance `
  --document-name EduMatch-Staging-Release `
  --parameters '{"ReleaseId":["<40-hex-git-sha>-<run-id>"],"Operation":["deploy"]}' `
  --query "Command.CommandId" --output text
```

`release.sh` verifies the data-volume mount, the release manifest, the image
revision labels, then starts the stack and writes `observed.json` to S3.

## 5. Logs

```powershell
aws logs tail /edumatch/staging --since 30m --follow
aws logs filter-log-events --log-group-name /edumatch/staging `
  --filter-pattern "{ $.releaseId = \"<release-id>\" }" --limit 50
```

On the host:

```powershell
aws ssm send-command --instance-ids $instance `
  --document-name "AWS-RunShellScript" `
  --parameters 'commands=["cd /opt/edumatch/current && docker compose --project-name edumatch-staging --env-file /opt/edumatch/runtime/.env ps"]'
```

A container in `running` state is not evidence that the application works.
Use the readiness checks in section 6.

## 6. Functional smoke

```bash
# Through the gateway, from inside the instance (no browser trust needed):
curl --resolve edumatch.staging.local:443:127.0.0.1 -fsS https://edumatch.staging.local/gateway/health
curl --resolve edumatch.staging.local:443:127.0.0.1 -fsS https://edumatch.staging.local/api/auth/health
curl --resolve edumatch.staging.local:443:127.0.0.1 -fsS https://edumatch.staging.local/api/scholarships?isPublic=true&page=0&size=5
```

## 7. Rollback

Code-only rollback: send the fixed document with the retained release ID.

```powershell
aws ssm send-command --instance-ids $instance `
  --document-name EduMatch-Staging-Release `
  --parameters '{"ReleaseId":["<retained-release-id>"],"Operation":["rollback"]}' `
  --query "Command.CommandId" --output text
```

`release_guard.py` refuses a rollback whose migration digest differs from the
running release, because reversing code does not reverse schema. Data recovery
is a separate, explicitly approved plan.

## 8. Backup

```bash
/opt/edumatch/bin/backup.sh /srv/edumatch/backups/$(date -u +%Y%m%dT%H%M%SZ)
```

Writers are stopped, databases are dumped to the encrypted volume, and
`SHA256SUMS` is written. An EBS snapshot alone is not an application-consistent
backup.

## 9. Stop the instance

`max-session.sh` already powers the host off after `max-session-hours`
(default 4) through a systemd timer, holding the same deploy lock so it cannot
interrupt an active deploy or backup.

Manual stop:

```powershell
aws ec2 stop-instances --instance-ids $instance
```

## 10. Cost

Rates are quoted from the AWS regional bulk catalogs for `ap-southeast-1`
(`npm run` target `scripts/extract-prices.mjs`); see
`artifacts/cost-estimate.json` for the current numbers and their provenance.

| Scenario | USD/month |
| --- | --- |
| 40 h running / 690 h stopped (the planning case) | 16.36 |
| Stopped for the whole month | 10.03 |
| Running 24/7 | 98.66 |

Two consequences matter operationally:

- **An always-on instance exceeds the 50 USD ceiling.** The bounded-session
  model is what keeps staging inside budget, which is why the auto-stop timer
  is part of the plan rather than an optional extra.
- **A stopped instance is not free.** EBS (root + data), snapshots, ECR storage,
  S3 objects and CloudWatch storage keep billing for the full month. Each
  4-hour session costs roughly 0.63 USD of marginal running cost on top of that
  floor.

The quote carries an explicit 20% tax/fee reserve, which is a conservative
assumption and not this account's actual tax rate.

## 11. Capacity check

The stack's Compose memory limits sum to about 5.2 GB (frontend 1 GB, three
Java services 0.4-0.5 GB each, matching 0.3 GB, four databases 0.25-0.38 GB
each, Redis and RabbitMQ). `t3a.large` provides 2 vCPU / 8 GiB, leaving roughly
2.8 GB for the OS, Docker and image layers. That is enough to run the stack but
leaves little headroom for concurrent builds, so images are intended to be
built off-host and pulled by digest. This has **not** been capacity-tested on a
live instance; treat it as a sizing estimate until a load run confirms it.

## 12. Known limitations

- No public DNS name or CA-issued certificate; TLS is self-signed and reached
  through SSM port forwarding plus a hosts-file entry.
- The GitHub Actions path is not usable until a real OIDC claim is verified;
  `oidc_claims_verified` stays `false` in manual mode by design, and the
  workflow's `environment: aws-staging` / `aws-staging-build` jobs have not been
  exercised.
- Rollback is code-only until a migration compatibility plan exists.
- Restore drill and RPO/RTO are not yet agreed (`AWS_RPO_MINUTES` /
  `AWS_RTO_MINUTES` are empty).
- The instance has never been started; every capacity and timing figure above is
  a pre-deployment estimate.
