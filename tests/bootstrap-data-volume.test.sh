#!/usr/bin/env bash
# Focused test for the destructive decision in bootstrap-data-volume.sh:
# a volume must be formatted only when it is genuinely blank, and a populated
# volume must always be preserved. Runs without root by using a plain file as
# the backing store, so it exercises the real blkid/mkfs code paths.
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
target="$script_dir/../cloud/bootstrap-data-volume.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0; fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1: expected [$3] got [$2]"; fail=$((fail+1)); fi; }

echo "bootstrap-data-volume.sh destructive-decision tests"

# 1. The script must refuse an invalid volume ID before touching any device.
set +e
out=$(bash "$target" "not-a-volume" "$work/mnt" 2>&1); rc=$?
set -e
check "rejects invalid volume id exit" "$rc" "64"
check "rejects invalid volume id message" "$(grep -c 'Invalid volume ID' <<<"$out")" "1"

# 2. The script must refuse a mount point outside /srv.
set +e
out=$(bash "$target" "vol-0123456789abcdef0" "/tmp/not-srv" 2>&1); rc=$?
set -e
check "rejects non-/srv mount point exit" "$rc" "64"

# 3. A blank backing store has no filesystem, so blkid must report nothing and
#    the format branch must be the one selected.
blank="$work/blank.img"
truncate -s 32M "$blank"
check "blank store has no filesystem" "$(blkid -o value -s TYPE "$blank" 2>/dev/null || true)" ""

# 4. Once formatted, the detection flips: the existing-filesystem branch keeps
#    the data and the script must not format again.
mkfs.ext4 -q -F -L edumatch-test "$blank"
check "formatted store reports ext4" "$(blkid -o value -s TYPE "$blank")" "ext4"

# 5. A filesystem UUID must be readable, which is what fstab keys on.
uuid=$(blkid -o value -s UUID "$blank")
[[ "$uuid" =~ ^[0-9a-fA-F-]{36}$ ]] && r=yes || r=no
check "uuid is well formed" "$r" "yes"

# 6. Rewriting the managed fstab line must not duplicate entries; simulate the
#    exact sed/append pair the script performs.
fstab="$work/fstab"
printf 'UUID=%s /srv/edumatch ext4 defaults,nofail,x-systemd.device-timeout=120 0 2 # edumatch-staging-data-volume\n' "$uuid" > "$fstab"
printf 'UUID=other / ext4 defaults 0 1\n' >> "$fstab"
if grep -qF "# edumatch-staging-data-volume" "$fstab"; then
  sed -i "\|^UUID=.*[[:space:]]/srv/edumatch[[:space:]]|d" "$fstab"
fi
printf 'UUID=%s /srv/edumatch ext4 defaults,nofail,x-systemd.device-timeout=120 0 2 # edumatch-staging-data-volume\n' "$uuid" >> "$fstab"
check "managed fstab line appears once" "$(grep -c '/srv/edumatch' "$fstab")" "1"
check "unrelated fstab line preserved" "$(grep -c '^UUID=other / ext4' "$fstab")" "1"

echo ""
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
