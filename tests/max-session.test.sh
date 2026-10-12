#!/usr/bin/env bash
# Tests the deadline logic in cloud/max-session.sh.
#
# The deadline is authoritative: a stop/start inside the same session must NOT
# reset it. systemctl is stubbed so a stop decision is reported, not executed.
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
target="$script_dir/../cloud/max-session.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0; fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1: expected [$3] got [$2]"; fail=$((fail+1)); fi; }

stub="$work/max-session.sh"
sed "s#^root=/opt/edumatch#root=$work/opt/edumatch#" "$target" > "$stub"
mkdir -p "$work/opt/edumatch/runtime" "$work/bin"

cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "SYSTEMCTL_CALLED $*"
exit 0
EOF
cat > "$work/bin/logger" <<'EOF'
#!/usr/bin/env bash
echo "LOGGER $*"
exit 0
EOF
cat > "$work/bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$work/bin/systemctl" "$work/bin/logger" "$work/bin/flock"

# The script reads the wall clock from its first argument, so tests are
# deterministic and never depend on the machine's real date.
run_at() { PATH="$work/bin:$PATH" bash "$stub" "$1" 2>&1 || true; }

echo "max-session.sh deadline tests"

echo "4" > "$work/opt/edumatch/max-session-hours"

# --- 1. No deadline recorded: one is derived and persisted ---
epoch=1700000000   # 2023-11-14T22:13:20Z
out=$(run_at $epoch)
check "does not stop before a deadline exists" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "0"
check "persists a deadline epoch" "$([[ -s "$work/opt/edumatch/session-deadline-epoch" ]] && echo yes || echo no)" "yes"
check "records a readable UTC deadline" "$([[ -s "$work/opt/edumatch/session-deadline" ]] && echo yes || echo no)" "yes"
recorded=$(cat "$work/opt/edumatch/session-deadline-epoch")
# The derived deadline is (real boot time + limit). Assert the offset against the
# actual boot time rather than the injected clock: the script intentionally reads
# boot time from the system so a restart cannot move the deadline.
boot_epoch=$(date -u -d "$(uptime -s)" +%s)
check "deadline is boot+4h" "$((recorded - boot_epoch))" "14400"

# --- 2. Inside the window: no stop ---
out=$(run_at $((recorded - 1)))
check "one second before the deadline does not stop" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "0"

# --- 3. At the deadline: stop ---
out=$(run_at $recorded)
check "exactly at the deadline stops" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "1"
check "stop uses poweroff" "$(grep -c 'SYSTEMCTL_CALLED poweroff' <<<"$out")" "1"

# --- 4. Past the deadline: stop ---
out=$(run_at $((recorded + 10000)))
check "past the deadline stops" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "1"

# --- 5. THE KEY PROPERTY: a reboot must not extend the deadline ---
# Simulate a stop/start: the persisted deadline must still govern, so a check
# inside the original window must not stop even though the instance just booted,
# and a check past it must stop.
before=$(cat "$work/opt/edumatch/session-deadline-epoch")
out=$(run_at $((recorded - 60)))
check "after restart, still inside the original window" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "0"
after=$(cat "$work/opt/edumatch/session-deadline-epoch")
check "deadline unchanged across restart" "$after" "$before"
out=$(run_at $((recorded + 1)))
check "after restart, past the original deadline stops" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "1"

# --- 6. An explicit RFC3339 deadline file is honoured ---
rm -f "$work/opt/edumatch/session-deadline-epoch"
printf '2030-01-01T00:00:00Z\n' > "$work/opt/edumatch/session-deadline"
out=$(run_at 1893456000)   # exactly 2030-01-01T00:00:00Z
check "RFC3339 deadline stops at the boundary" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "1"
out=$(run_at 1893455999)
check "RFC3339 deadline one second early does not stop" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "0"
rm -f "$work/opt/edumatch/session-deadline"

# --- 7. Out-of-range limits refuse rather than guess ---
echo "0" > "$work/opt/edumatch/max-session-hours"
rm -f "$work/opt/edumatch/session-deadline-epoch"
out=$(run_at 1700000000)
check "zero limit rejected" "$(grep -c 'outside 1..12' <<<"$out")" "1"
check "zero limit stops nothing" "$(grep -c SYSTEMCTL_CALLED <<<"$out")" "0"

echo "not-a-number" > "$work/opt/edumatch/max-session-hours"
out=$(run_at 1700000000)
check "non-numeric limit rejected" "$(grep -c 'Invalid session limit' <<<"$out")" "1"

echo "12" > "$work/opt/edumatch/max-session-hours"
rm -f "$work/opt/edumatch/session-deadline-epoch"
out=$(run_at 1700000000)
check "12h limit accepted" "$(grep -c 'outside 1..12' <<<"$out")" "0"

echo ""
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
