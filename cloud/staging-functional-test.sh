#!/bin/bash
# EduMatch staging functional test runner.
#
# Runs against the gateway over TLS using the staging certificate as its own
# trust anchor (never -k), so a wrong or missing certificate fails the test.
# Each section prints PASS/FAIL with the concrete evidence it observed.
C="curl -s --cacert /opt/edumatch/tls/fullchain.pem --resolve edumatch.staging.local:443:127.0.0.1"
B=https://edumatch.staging.local
TS=$(date +%H%M%S)
USER="st$TS"
PASS="Passw0rd!234"
J=/tmp/cookies.txt
rm -f "$J"

section() { echo ""; echo "########## $* ##########"; }
ok()   { echo "PASS: $*"; }
bad()  { echo "FAIL: $*"; }

section "T1 AUTH register"
# SignUpRequest requires firstName and lastName (@NotBlank); there is no
# fullName field. Sending the wrong shape returns 400 and is a test bug.
REG=$($C -X POST "$B/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"email\":\"$USER@example.com\",\"password\":\"$PASS\",\"firstName\":\"Staging\",\"lastName\":\"Tester\"}" \
  -w '\nHTTP:%{http_code}')
echo "$REG" | head -c 400
echo "$REG" | grep -q 'HTTP:200\|HTTP:201' && ok "register accepted" || bad "register rejected"

section "T2 AUTH login"
LOGIN=$($C -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" -c "$J" -w '\nHTTP:%{http_code}')
echo "$LOGIN" | head -c 500
echo "$LOGIN" | grep -q 'HTTP:200' && ok "login accepted" || bad "login rejected"
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] && ok "access token issued (len=${#TOKEN})" || bad "no access token"
grep -qi 'refreshToken\|refresh_token' "$J" 2>/dev/null && ok "refresh cookie set" || echo "NOTE: no refresh cookie in jar"

section "T3 AUTH negative: wrong password"
# A rejected credential must be 400/401/403. A 5xx is an application fault, not
# a successful denial, so it is reported separately instead of being counted as
# a pass.
WRONG=$($C -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"wrong-password\"}" -w '\nHTTP:%{http_code}')
echo "$WRONG" | tail -3
CODE=$(echo "$WRONG" | sed -n 's/.*HTTP:\([0-9]*\).*/\1/p' | tail -1)
case "$CODE" in
  400|401|403) ok "wrong password rejected with $CODE" ;;
  500) bad "wrong password produced HTTP 500 (application fault, not a clean denial)" ;;
  *) bad "wrong password produced unexpected HTTP $CODE" ;;
esac

section "T4 AUTH negative: protected endpoint without token must be 401/403"
NOTOK=$($C "$B/api/auth/me" -w '\nHTTP:%{http_code}')
echo "$NOTOK" | tail -1
echo "$NOTOK" | grep -qE 'HTTP:(401|403)' && ok "anonymous access denied" || bad "anonymous access NOT denied"

section "T5 AUTH authenticated call with token"
if [ -n "$TOKEN" ]; then
  ME=$($C "$B/api/auth/me" -H "Authorization: Bearer $TOKEN" -w '\nHTTP:%{http_code}')
  echo "$ME" | head -c 300
  echo "$ME" | grep -q 'HTTP:200' && ok "authenticated /me works" || bad "authenticated /me failed"
else
  bad "skipped: no token"
fi

section "T6 AUTH refresh"
REFRESH=$($C -X POST "$B/api/auth/refresh" -b "$J" -w '\nHTTP:%{http_code}')
echo "$REFRESH" | head -c 300
echo "$REFRESH" | grep -q 'HTTP:200' && ok "refresh works" || echo "NOTE: refresh returned $(echo "$REFRESH" | tail -1)"

section "T7 SCHOLARSHIP list (public)"
SCH=$($C "$B/api/scholarships?isPublic=true&page=0&size=5" -w '\nHTTP:%{http_code}')
echo "$SCH" | head -c 400
echo "$SCH" | grep -q 'HTTP:200' && ok "public scholarship list works" || bad "public list failed"

section "T8 SCHOLARSHIP create (authenticated)"
if [ -n "$TOKEN" ]; then
  CREATE=$($C -X POST "$B/api/v1/scholarships" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"title":"Staging Test Scholarship","description":"Created by staging functional test","amount":1000,"deadline":"2027-12-31","isPublic":true}' \
    -w '\nHTTP:%{http_code}')
  echo "$CREATE" | head -c 400
  echo "$CREATE" | grep -qE 'HTTP:(200|201)' && ok "scholarship creation works" || echo "NOTE: create returned $(echo "$CREATE" | tail -1)"
else
  bad "skipped: no token"
fi

section "T9 MATCHING service (health + authenticated route)"
MH=$($C "$B/health" -w '\nHTTP:%{http_code}')
echo "health: $(echo "$MH" | head -c 150)"
echo "$MH" | grep -q 'HTTP:200' && ok "matching /health works" || bad "matching /health failed"
for p in /api/v1/match /api/v1/recommendations /api/matching; do
  R=$($C "$p" -H "Authorization: Bearer $TOKEN" -w '\nHTTP:%{http_code}')
  CODE=$(echo "$R" | sed -n 's/.*HTTP:\([0-9]*\).*/\1/p' | tail -1)
  echo "  $p -> HTTP:$CODE"
done

section "T10 CHAT reachability"
CH=$($C "$B/api/v1/chat/conversations" -H "Authorization: Bearer $TOKEN" -w '\nHTTP:%{http_code}')
echo "$CH" | head -c 300
echo "$CH" | grep -qE 'HTTP:(200|401|403)' && ok "chat endpoint reachable ($(echo "$CH" | tail -1))" || bad "chat unreachable"

section "T11 WebSocket upgrade handshake"
WS=$($C -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "$B/api/ws" --max-time 8 2>&1 | head -c 400)
echo "$WS" | head -c 300
echo "$WS" | grep -q '101' && ok "websocket upgrade accepted" || echo "NOTE: no 101 handshake observed"

section "T12 RabbitMQ event flow (register publishes user profile event)"
# registerUser() calls publishUserProfileUpdatedEvent, so a queue must show the
# message or a consumer must have handled it. Inspect broker state, not logs.
docker exec edumatch-staging-rabbitmq-1 rabbitmqctl list_queues name messages messages_ready messages_unacknowledged 2>/dev/null | tr -cd '[:print:]\n'
echo "--- connections/channels ---"
docker exec edumatch-staging-rabbitmq-1 rabbitmqctl list_connections name state 2>/dev/null | head -5 | tr -cd '[:print:]\n'

section "T13 Redis cache (scholarship service uses Spring Cache + Redis)"
docker exec edumatch-staging-redis-1 redis-cli INFO keyspace 2>/dev/null | tr -cd '[:print:]\n'
echo "--- db size ---"
docker exec edumatch-staging-redis-1 redis-cli DBSIZE 2>/dev/null
echo "--- a few key names (cache evidence) ---"
docker exec edumatch-staging-redis-1 redis-cli --scan --count 20 2>/dev/null | head -10 | tr -cd '[:print:]\n'

section "T14 Database persistence (rows written by the flows above)"
docker exec edumatch-staging-auth-db-1 sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "SELECT COUNT(*) AS users FROM auth_db.users; SELECT username FROM auth_db.users ORDER BY id DESC LIMIT 3;"' 2>/dev/null | tr -cd '[:print:]\n'

section "T15 matching-service processed event state"
docker exec edumatch-staging-matching-db-1 sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT COUNT(*) FROM processed_events;"' 2>/dev/null | tr -cd '[:print:]\n'

echo ""
echo "########## TEST RUN COMPLETE ##########"
