#!/bin/bash
# Load EduMatch demo data into the running staging stack.
#
# Mirrors scripts/seed-dev-data.ps1 but runs against the deployment's own
# containers instead of a developer Compose project. The SQL files are the
# audited ones from db/seed, so the fixture shape matches what the application
# expects rather than being invented here.
#
# Every statement is idempotent (INSERT IGNORE / ON DUPLICATE KEY UPDATE), so a
# rerun updates rather than duplicates.
set -euo pipefail
SEED_DIR=${1:?seed directory on the host}

compose() {
  docker compose --project-name edumatch-staging --env-file /opt/edumatch/runtime/.env \
    -f /opt/edumatch/current/compose.yml "$@"
}

run_mysql() { # container db sqlfile
  local container=$1 db=$2 file=$3
  echo "==> seeding $db from $(basename "$file")"
  # The root password is read from the container's own environment so it never
  # appears in a command line, a log, or this script's output.
  compose exec -T "$container" sh -c \
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$1"' _ "$db" < "$file"
  echo "    ok"
}

run_psql() { # container db sqlfile
  local container=$1 db=$2 file=$3
  echo "==> seeding $db from $(basename "$file")"
  compose exec -T "$container" sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1' _ "$db" < "$file"
  echo "    ok"
}

run_mysql auth-db        auth_db        "$SEED_DIR/auth-dev.sql"
run_mysql scholarship-db scholarship_db "$SEED_DIR/scholarship-dev.sql"
run_mysql chat-db        chat_db        "$SEED_DIR/chat-dev.sql"
run_psql  matching-db    matching_db    "$SEED_DIR/matching-dev.sql"

echo ""
echo "=== row counts ==="
compose exec -T auth-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "
  SELECT CONCAT(\"users=\", COUNT(*)) FROM auth_db.users;
  SELECT CONCAT(\"roles=\", COUNT(*)) FROM auth_db.roles;
  SELECT CONCAT(r.name, \"=\", COUNT(ur.user_id)) FROM auth_db.roles r
    LEFT JOIN auth_db.user_roles ur ON ur.role_id = r.id GROUP BY r.name ORDER BY r.name;"'

echo ""
echo "=== seeded accounts and their roles ==="
compose exec -T auth-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "
  SELECT CONCAT(u.username, \" | \", u.email, \" | \", GROUP_CONCAT(r.name ORDER BY r.name))
  FROM auth_db.users u
  LEFT JOIN auth_db.user_roles ur ON ur.user_id = u.id
  LEFT JOIN auth_db.roles r ON r.id = ur.role_id
  WHERE u.username IN (\"admin\",\"admin_test\",\"student1\",\"student2\",\"student3\",\"teacher1\",\"teacher2\",\"mit_provider\",\"stanford_provider\",\"google_provider\")
  GROUP BY u.id ORDER BY u.username;"'

echo ""
echo "=== scholarship/application counts ==="
compose exec -T scholarship-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "
  SELECT CONCAT(\"scholarships=\", COUNT(*)) FROM scholarship_db.scholarships;
  SELECT CONCAT(\"applications=\", COUNT(*)) FROM scholarship_db.applications;
  SELECT CONCAT(\"bookmarks=\", COUNT(*)) FROM scholarship_db.bookmarks;"' 2>/dev/null || echo "(scholarship tables differ; listing them)"
compose exec -T scholarship-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "SHOW TABLES FROM scholarship_db;"' 2>/dev/null | tr '\n' ' '
echo ""

echo ""
echo "=== matching data ==="
compose exec -T matching-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
  SELECT '\''applicant_features='\'' || COUNT(*) FROM applicant_features;
  SELECT '\''opportunity_features='\'' || COUNT(*) FROM opportunity_features;"' 2>/dev/null || echo "(matching tables differ)"
echo ""

echo ""
echo "=== chat data ==="
compose exec -T chat-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "SHOW TABLES FROM chat_db;"' 2>/dev/null | tr '\n' ' '
echo ""
echo "SEED_DONE"
