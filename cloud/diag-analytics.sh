#!/bin/bash
# Reproduce the provider analytics 500 and capture the server-side cause.
set -u
B=https://edumatch.staging.local
CURL="curl -s --cacert /opt/edumatch/tls/fullchain.pem --resolve edumatch.staging.local:443:127.0.0.1"

T=$(curl -s --cacert /opt/edumatch/tls/fullchain.pem --resolve edumatch.staging.local:443:127.0.0.1 \
  -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"mit_provider","password":"admin123"}' |
  sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

echo "=== provider/analytics ==="
$CURL -H "Authorization: Bearer $T" "$B/api/v1/provider/analytics" -w '\nHTTP:%{http_code}\n' | head -c 400

echo ""
echo "=== the provider's own user id (what the query keys on) ==="
$CURL -H "Authorization: Bearer $T" "$B/api/user/me" | head -c 250

echo ""
echo "=== opportunities owned by that user ==="
docker exec edumatch-staging-scholarship-db-1 sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "
  SELECT CONCAT(\"creator_user_id=\", creator_user_id, \" count=\", COUNT(*)) FROM scholarship_db.opportunities GROUP BY creator_user_id;
  SELECT CONCAT(\"total opportunities=\", COUNT(*)) FROM scholarship_db.opportunities;"' 2>&1 | tr -cd '[:print:]\n'

echo ""
echo "=== ANY error in scholarship-service in the last 2 minutes ==="
docker logs --since 2m edumatch-staging-scholarship-service-1 2>&1 | tail -30 | tr -cd '[:print:]\n'
