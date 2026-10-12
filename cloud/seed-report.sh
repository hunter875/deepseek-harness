#!/bin/bash
# Report seeded row counts across the staging databases.
#
# The password is read from the container's own environment inside `sh -c`, so
# it never appears in an argument list or in this script's output.
set -u
C() { docker compose --project-name edumatch-staging --env-file /opt/edumatch/runtime/.env -f /opt/edumatch/current/compose.yml "$@"; }

echo "=== auth_db ==="
C exec -T auth-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "
  SELECT CONCAT(\"users=\", COUNT(*)) FROM auth_db.users;
  SELECT CONCAT(r.name, \" = \", COUNT(ur.user_id)) FROM auth_db.roles r
    LEFT JOIN auth_db.user_roles ur ON ur.role_id=r.id GROUP BY r.name ORDER BY r.name;"' 2>&1 | tr -cd '[:print:]\n'

echo ""
echo "=== scholarship_db ==="
C exec -T scholarship-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "
  SELECT CONCAT(\"opportunities=\", COUNT(*)) FROM scholarship_db.opportunities;
  SELECT CONCAT(\"  public=\", COUNT(*)) FROM scholarship_db.opportunities WHERE is_public=1;
  SELECT CONCAT(\"applications=\", COUNT(*)) FROM scholarship_db.applications;
  SELECT CONCAT(\"bookmarks=\", COUNT(*)) FROM scholarship_db.bookmarks;
  SELECT CONCAT(\"outbox_events=\", COUNT(*)) FROM scholarship_db.outbox_events;
  SELECT CONCAT(\"tags=\", COUNT(*)) FROM scholarship_db.tags;"' 2>&1 | tr -cd '[:print:]\n'

echo ""
echo "=== chat_db ==="
C exec -T chat-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "
  SELECT CONCAT(\"conversations=\", COUNT(*)) FROM chat_db.conversations;
  SELECT CONCAT(\"messages=\", COUNT(*)) FROM chat_db.messages;
  SELECT CONCAT(\"notifications=\", COUNT(*)) FROM chat_db.notifications;"' 2>&1 | tr -cd '[:print:]\n'

echo ""
echo "=== matching_db ==="
C exec -T matching-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
  SELECT CONCAT(\"applicant_features=\", COUNT(*)) FROM applicant_features;
  SELECT CONCAT(\"opportunity_features=\", COUNT(*)) FROM opportunity_features;
  SELECT CONCAT(\"matching_scores=\", COUNT(*)) FROM matching_scores;
  SELECT CONCAT(\"recommendation_cache=\", COUNT(*)) FROM recommendation_cache;"' 2>&1 | tr -cd '[:print:]\n'
