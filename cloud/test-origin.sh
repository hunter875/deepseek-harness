#!/bin/bash
# Reproduce the browser-originated request from inside the instance.
#
# The browser test saw HTTP 403 on /api/auth/register while a curl without an
# Origin header saw 200. This isolates whether the Origin header is the trigger.
C="curl -s --cacert /opt/edumatch/tls/fullchain.pem --resolve edumatch.staging.local:443:127.0.0.1"
B=https://edumatch.staging.local
TS=$(date +%s)

echo "=== 1. register WITHOUT Origin ==="
$C -X POST "$B/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"noorg$TS\",\"email\":\"noorg$TS@example.com\",\"password\":\"Passw0rd!234\",\"firstName\":\"N\",\"lastName\":\"O\"}" \
  -w '\nHTTP:%{http_code}\n' | tail -2

echo ""
echo "=== 2. register WITH Origin ==="
$C -X POST "$B/api/auth/register" -H 'Content-Type: application/json' \
  -H "Origin: $B" \
  -d "{\"username\":\"withorg$TS\",\"email\":\"withorg$TS@example.com\",\"password\":\"Passw0rd!234\",\"firstName\":\"W\",\"lastName\":\"O\"}" \
  -w '\nHTTP:%{http_code}\n' | tail -3

echo ""
echo "=== 3. preflight OPTIONS with Origin ==="
$C -X OPTIONS "$B/api/auth/register" -H "Origin: $B" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' -i 2>&1 | head -14 | tr -cd '[:print:]\n'

echo ""
echo "=== 4. what nginx does with Origin for this path ==="
grep -n 'proxy_set_header Origin' /opt/edumatch/current/nginx.conf | head -5
