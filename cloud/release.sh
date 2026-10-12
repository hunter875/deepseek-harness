#!/bin/bash
set -euo pipefail
release_id=${1:?release id}; operation=${2:?operation}
[[ "$release_id" =~ ^[a-f0-9]{40}-[0-9]+$ ]] || exit 64
[[ "$operation" == deploy || "$operation" == rollback ]] || exit 64
root=/opt/edumatch
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Deploy lease is busy'; exit 75; }
# Application containers store all state on the encrypted data volume, so the
# release refuses to start anything until that exact filesystem is mounted.
mountpoint -q /srv/edumatch || { echo 'Data EBS mount is required'; exit 78; }
data_volume_id=$(cat "$root/data-volume-id" 2>/dev/null || true)
data_volume_uuid=$(cat "$root/data-volume-uuid" 2>/dev/null || true)
[[ "$data_volume_id" =~ ^vol-[a-f0-9]+$ ]] || { echo 'Run bootstrap-data-volume.sh first: data volume ID unknown'; exit 78; }
[[ "$data_volume_uuid" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo 'Run bootstrap-data-volume.sh first: filesystem UUID unknown'; exit 78; }
observed_uuid=$(findmnt -n -o UUID --target /srv/edumatch || true)
[[ "$observed_uuid" == "$data_volume_uuid" ]] || { echo "Refusing to deploy: /srv/edumatch is not the bound data volume (expected $data_volume_uuid, got $observed_uuid)"; exit 78; }
test -s "$root/runtime/.env" && test -s "$root/tls/fullchain.pem" && test -s "$root/tls/privkey.pem"
# RSA material is mounted read-only into containers running as uid 100 (the Java
# images' `app` user, gid 101) and uid 10001 (matching). A root-owned 0600 file
# is unreadable by both, and the services then fail their JWT bean with
# "Permission denied" while still starting far enough to be confusing. The
# public key is not secret; the private key is group-readable by the Java gid.
if [[ -d "$root/secrets" ]]; then
  chmod 0644 "$root/secrets/jwt-public.pem" 2>/dev/null || true
  if [[ -f "$root/secrets/jwt-private.pem" ]]; then
    chgrp 101 "$root/secrets/jwt-private.pem" 2>/dev/null || true
    chmod 0640 "$root/secrets/jwt-private.pem"
  fi
fi
bucket=$(cat "$root/release-bucket")
dir="$root/releases/$release_id"
install -d -m 0700 "$dir"
for file in manifest.json compose.yml nginx.conf; do
  aws s3 cp "s3://$bucket/releases/$release_id/$file" "$dir/$file" --only-show-errors
done
python3 "$root/bin/release_guard.py" "$dir" "$root/current" "$operation"
account=$(jq -r .accountId "$dir/manifest.json")
actual_account=$(aws sts get-caller-identity --region ap-southeast-1 --query Account --output text)
[[ "$actual_account" == "$account" ]] || { echo 'Actual instance account differs from release target'; exit 78; }
registry="$account.dkr.ecr.ap-southeast-1.amazonaws.com"
aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin "$registry" >/dev/null
compose=(docker compose --project-name edumatch-staging --env-file "$root/runtime/.env" -f "$dir/compose.yml")
"${compose[@]}" config --quiet
"${compose[@]}" pull
# Labels are tied to the built digest, independently from runtime APP_VERSION.
# The observed value is trimmed: a label built with an embedded newline renders
# as "\n<sha>\n", and comparing that verbatim against the manifest revision
# fails even though the revision is correct. Trimming is defensive on both sides
# so a build that adds incidental whitespace cannot masquerade as a wrong build.
expected_revision=$(jq -r .sourceRevision "$dir/manifest.json")
expected_revision="${expected_revision//[[:space:]]/}"
[[ -n "$expected_revision" ]] || { echo 'Manifest has no sourceRevision'; exit 65; }
for service in auth-service scholarship-service chat-service matching-service frontend api-gateway; do
  image=$(jq -r --arg service "$service" '.images[$service]' "$dir/manifest.json")
  observed=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  observed="${observed//[[:space:]]/}"
  [[ "$observed" == "$expected_revision" ]] || { echo "Source label mismatch: $service (expected $expected_revision, got $observed)"; exit 65; }
done
# `up --wait` refuses to succeed when any service lacks a healthcheck, and the
# audited Compose deliberately gives matching-consumer none (a queue worker has
# no HTTP endpoint to probe). Wait only on the services that do declare one;
# observe_release.py independently asserts each of them reports healthy and
# that the consumer is running.
"${compose[@]}" up -d
"${compose[@]}" up -d --wait --wait-timeout 600 auth-service scholarship-service chat-service matching-service frontend api-gateway
python3 "$root/bin/observe_release.py" "$dir" "$root/runtime/.env" > "$dir/observed.json"
# Validate TLS and request behavior outside the application containers. The
# staging certificate is self-signed, so curl is given that exact certificate as
# its trust anchor instead of -k: disabling verification would make this check
# unable to detect a wrong or missing certificate.
domain=$(jq -r .tlsDomain "$dir/manifest.json")
curl --fail --silent --show-error --cacert "$root/tls/fullchain.pem" --resolve "$domain:443:127.0.0.1" "https://$domain/gateway/health" >/dev/null
curl --fail --silent --show-error --cacert "$root/tls/fullchain.pem" --resolve "$domain:443:127.0.0.1" "https://$domain/api/auth/health" >/dev/null
curl --fail --silent --show-error --cacert "$root/tls/fullchain.pem" --resolve "$domain:443:127.0.0.1" "https://$domain/" >/dev/null
ln -sfn "$dir" "$root/current"
aws s3 cp "$dir/observed.json" "s3://$bucket/status/$release_id.json" --only-show-errors
echo "RECONCILED $release_id; CI external smoke still required; rollback category=code-only"
