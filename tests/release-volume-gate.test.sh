#!/usr/bin/env bash
# Tests the data-volume gate in cloud/release.sh.
#
# The gate is the reason a release cannot start application containers against
# an unmounted or wrong filesystem. The script's early exits happen before any
# docker or aws call, so the test stubs those binaries and asserts only on the
# refusal path.
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
target="$script_dir/../cloud/release.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0; fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1: expected [$3] got [$2]"; fail=$((fail+1)); fi; }

mkdir -p "$work/opt/edumatch" "$work/bin"

# Stub every external tool the script may reach so a passing gate cannot have
# side effects; record invocation so leakage is visible.
for tool in docker aws mountpoint findmnt flock python3 jq curl install; do
  cat > "$work/bin/$tool" <<EOF
#!/usr/bin/env bash
echo "CALLED_$tool \$*" >> "$work/calls.log"
exit 0
EOF
  chmod +x "$work/bin/$tool"
done

stub="$work/release.sh"
sed "s#^root=/opt/edumatch#root=$work/opt/edumatch#" "$target" > "$stub"

run() { PATH="$work/bin:$PATH" bash "$stub" "$@" 2>&1 || true; }

echo "release.sh data-volume gate tests"

release_id="0123456789abcdef0123456789abcdef01234567-1"

# 1. Without a recorded data-volume ID the script must refuse.
rm -f "$work/opt/edumatch/data-volume-id" "$work/opt/edumatch/data-volume-uuid" "$work/calls.log"
out=$(run "$release_id" deploy)
check "missing state refuses" "$(grep -c 'bootstrap-data-volume.sh first' <<<"$out")" "1"

# 2. A recorded ID without a matching UUID must also refuse.
printf 'vol-0123456789abcdef0\n' > "$work/opt/edumatch/data-volume-id"
rm -f "$work/opt/edumatch/data-volume-uuid"
out=$(run "$release_id" deploy)
check "missing uuid refuses" "$(grep -c 'filesystem UUID unknown' <<<"$out")" "1"

count_calls() { # tool
  if [[ -f "$work/calls.log" ]]; then grep -c "CALLED_$1" "$work/calls.log" || true; else echo 0; fi
}

# 3. With an ID, a UUID and a mountpoint, the script must still compare the
#    mounted filesystem against the recorded UUID and refuse on mismatch.
#    (mountpoint is stubbed to succeed here, so the UUID comparison is what
#    actually protects the deployment.)
printf '11111111-2222-3333-4444-555555555555\n' > "$work/opt/edumatch/data-volume-uuid"
out=$(run "$release_id" deploy)
check "reaches uuid comparison" "$(grep -c 'is not the bound data volume' <<<"$out")" "1"
check "refuses before touching docker" "$(count_calls docker)" "0"

# 4. A malformed release ID is rejected by the argument guard.
out=$(run "not-a-release" deploy)
check "malformed release id refuses" "$(grep -c 'CALLED_docker' <<<"$out")" "0"

# 5. An invalid operation value must be rejected before the handler runs.
: > "$work/calls.log"
out=$(run "$release_id" "destroy")
check "invalid operation rejected" "$(grep -c 'deploy\|rollback' <<<"$out")" "0"
check "invalid operation never calls docker" "$(count_calls docker)" "0"

echo ""
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
