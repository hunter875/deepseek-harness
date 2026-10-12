#!/bin/bash
set -euo pipefail
# Only restore into a pre-provisioned disposable Compose fixture project.
project=${1:?fixture project}; backup=${2:?backup directory}; compose_file=${3:?fixture Compose}
[[ "$project" =~ ^edumatch-restore-[a-z0-9-]+$ ]] || exit 64
test -f "$backup/SHA256SUMS"
sha256sum --check "$backup/SHA256SUMS"
compose=(docker compose --project-name "$project" -f "$compose_file")
"${compose[@]}" exec -T matching-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$backup/matching.dump"
for database in auth-db scholarship-db chat-db; do
  "${compose[@]}" exec -T "$database" sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE"' < "$backup/$database.sql"
done
echo 'Restore completed in disposable fixture; evaluator must compare frozen row counts/invariants and measured RPO/RTO'
