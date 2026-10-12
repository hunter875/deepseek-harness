#!/bin/bash
set -euo pipefail
# Auto-stop for a bounded staging session, anchored to a FIXED UTC deadline.
#
# The session deadline is a timestamp, not a duration measured from boot. A
# stop/start cycle therefore does not silently grant a fresh window: if the
# operator re-enables the instance inside the same session, only the time left
# until the deadline remains.
#
# Resolution order for the deadline:
#   1. /opt/edumatch/session-deadline        absolute UTC timestamp (authoritative)
#   2. /opt/edumatch/session-deadline-epoch  same value as a unix timestamp
#   3. fallback: boot time + max-session-hours, for hosts provisioned before
#      deadlines existed. The computed value is then persisted so subsequent
#      invocations (and restarts) keep the same instant.
#
# The deploy lease is held while stopping so an in-flight deploy or backup is
# never interrupted; if the lease is busy the timer retries on its next tick.
root=/opt/edumatch
now_epoch=${1:-$(date -u +%s)}

limit_hours=""
if [[ -s "$root/max-session-hours" ]]; then
  limit_hours=$(tr -d '[:space:]' < "$root/max-session-hours")
fi
# A runtime override wins over the provisioned default.
if [[ -s "$root/runtime/.env" ]]; then
  override=$(grep -E '^EDUMATCH_MAX_SESSION_HOURS=' "$root/runtime/.env" | tail -n1 | cut -d= -f2 | tr -d '[:space:]' || true)
  [[ -n "$override" ]] && limit_hours=$override
fi

[[ "$limit_hours" =~ ^[0-9]+$ ]] || { logger -t edumatch-session "Invalid session limit '$limit_hours'; refusing to guess"; exit 78; }
(( limit_hours >= 1 && limit_hours <= 12 )) || { logger -t edumatch-session "Session limit $limit_hours outside 1..12"; exit 78; }

deadline_epoch=""
if [[ -s "$root/session-deadline-epoch" ]]; then
  deadline_epoch=$(tr -d '[:space:]' < "$root/session-deadline-epoch")
elif [[ -s "$root/session-deadline" ]]; then
  # Parse an RFC3339/ISO-8601 UTC timestamp; date -d is available on AL2023.
  raw=$(tr -d '[:space:]' < "$root/session-deadline")
  deadline_epoch=$(date -u -d "$raw" +%s 2>/dev/null || true)
fi

if ! [[ "$deadline_epoch" =~ ^[0-9]+$ ]]; then
  # No deadline recorded yet: derive it once from the current boot and persist,
  # so a later restart cannot move the goalposts.
  boot_epoch=$(date -u -d "$(uptime -s)" +%s 2>/dev/null || echo "$now_epoch")
  deadline_epoch=$(( boot_epoch + limit_hours * 3600 ))
  install -d -m 0700 "$root"
  printf '%s\n' "$deadline_epoch" > "$root/session-deadline-epoch"
  date -u -d "@$deadline_epoch" +%Y-%m-%dT%H:%M:%SZ > "$root/session-deadline" 2>/dev/null || true
  logger -t edumatch-session "Recorded session deadline $(date -u -d "@$deadline_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$deadline_epoch")"
fi

if (( now_epoch < deadline_epoch )); then
  exit 0
fi

exec 9>"$root/deploy.lock"
flock -n 9 || exit 0
remaining_note="deadline $(date -u -d "@$deadline_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$deadline_epoch") reached"
logger -t edumatch-session "Authorized staging session elapsed ($remaining_note); stopping via OS shutdown"
systemctl poweroff
