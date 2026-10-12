#!/bin/bash
# Reproduce a 500 and capture the server-side stack trace.
#
# The gateway response says only "Unexpected server error"; the cause is in the
# service log, so trigger the call then read the tail of that service's log.
set -u
B=https://edumatch.staging.local
CURL="curl -s --cacert /opt/edumatch/tls/fullchain.pem --resolve edumatch.staging.local:443:127.0.0.1"

login() {
  $CURL -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"admin123\"}" |
    sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'
}

echo "=== provider/analytics as mit_provider ==="
T=$(login mit_provider)
echo "status: $($CURL -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$B/api/v1/provider/analytics")"
sleep 2
echo "--- log tail ---"
docker logs --since 40s edumatch-staging-scholarship-service-1 2>&1 | grep -vE '^\s*$' | tail -30 | tr -cd '[:print:]\n'
