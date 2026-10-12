#!/bin/bash
set -euo pipefail
root=/opt/edumatch
mountpoint -q /srv/edumatch
exec 9>"$root/deploy.lock"; flock -n 9
directory=${1:?backup destination on encrypted data volume}
case "$directory" in /srv/edumatch/backups/*) ;; *) exit 64 ;; esac
install -d -m 0700 "$directory"
compose=(docker compose --project-name edumatch-staging --env-file "$root/runtime/.env" -f "$root/current/compose.yml")
# Quiesce application writers while retaining databases; do not use EBS snapshot alone.
trap '"${compose[@]}" start auth-service scholarship-service chat-service matching-service matching-consumer' EXIT
"${compose[@]}" stop auth-service scholarship-service chat-service matching-service matching-consumer
"${compose[@]}" exec -T matching-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$directory/matching.dump"
for database in auth-db scholarship-db chat-db; do
  "${compose[@]}" exec -T "$database" sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --single-transaction --routines --triggers -u "$MYSQL_USER" "$MYSQL_DATABASE"' > "$directory/$database.sql"
done
cp "$root/current/manifest.json" "$directory/release.json"
sha256sum "$directory"/*.dump "$directory"/*.sql "$directory/release.json" > "$directory/SHA256SUMS"
echo 'Encrypted-volume backup completed; restore drill and RPO/RTO remain separate gates'
