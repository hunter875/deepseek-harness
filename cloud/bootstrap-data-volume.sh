#!/bin/bash
set -euo pipefail
# EduMatch staging data-volume bootstrap.
#
# Idempotent by design: it identifies the Terraform EBS data volume by its
# AWS volume ID (matched against the on-disk serial), waits for the attachment
# and device to appear, creates a filesystem only when the volume is genuinely
# blank, records the filesystem UUID, and writes an fstab entry keyed by that
# UUID. Re-running it on a populated volume is a no-op that never formats.
#
# Usage: bootstrap-data-volume.sh <data-volume-id> [mount-point]
#   data-volume-id : vol-xxxxxxxx (Terraform aws_ebs_volume.data.id)
#   mount-point    : defaults to /srv/edumatch

data_volume_id=${1:?Terraform data volume ID (vol-...)}
mount_point=${2:-/srv/edumatch}

[[ "$data_volume_id" =~ ^vol-[a-f0-9]+$ ]] || { echo "Invalid volume ID: $data_volume_id" >&2; exit 64; }
[[ "$mount_point" == /srv/* ]] || { echo "Mount point must live under /srv: $mount_point" >&2; exit 64; }

log() { logger -t edumatch-data-volume "$*" 2>/dev/null || true; echo "[data-volume] $*"; }

# AWS exposes the volume ID as the block-device serial. Nitro instances report
# it with a "vol" prefix ("vol0abc...") while older Xen layouts report the bare
# ID, so both the target and the observed serial are normalized the same way:
# strip separators and any leading "vol".
normalize_volume_id() { printf '%s' "$1" | tr -d '[:space:]-' | sed 's/^vol//'; }
normalized_id=$(normalize_volume_id "$data_volume_id")

volume_serial() {
  local device=$1
  local serial
  serial=$(lsblk -ndo SERIAL "$device" 2>/dev/null || true)
  normalize_volume_id "$serial"
}

log "Resolving device for $data_volume_id"
deadline=$((SECONDS + 300))
device=""
while (( SECONDS < deadline )); do
  for candidate in /dev/nvme*n1 /dev/xvd[f-z] /dev/sd[f-z]; do
    [[ -b "$candidate" ]] || continue
    if [[ "$(volume_serial "$candidate")" == "$normalized_id" ]]; then
      device=$candidate
      break
    fi
  done
  [[ -n "$device" ]] && break
  # The volume can exist while the attachment is still converging.
  sleep 5
done

[[ -n "$device" ]] || { echo "Data volume $data_volume_id never appeared as a block device" >&2; exit 78; }
log "Matched $data_volume_id to $device"

# Wait until the device reports a stable size; an attaching volume can briefly
# be readable but report zero sectors.
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  size=$(blockdev --getsize64 "$device" 2>/dev/null || echo 0)
  (( size > 0 )) && break
  sleep 3
done
(( size > 0 )) || { echo "Device $device never reported a usable size" >&2; exit 78; }
log "Device size: $size bytes"

existing_fs=$(blkid -o value -s TYPE "$device" 2>/dev/null || true)

if [[ -z "$existing_fs" ]]; then
  # A blank volume is the only case where formatting is allowed.
  log "No filesystem detected; creating ext4 on $device"
  mkfs.ext4 -F -L edumatch-data "$device"
  existing_fs=ext4
  partprobe "$device" 2>/dev/null || true
  udevadm settle 2>/dev/null || true
else
  log "Existing $existing_fs filesystem preserved; refusing to format"
fi

# Establish the UUID from the filesystem itself, never from the device path.
fs_uuid=$(blkid -o value -s UUID "$device" 2>/dev/null || true)
[[ "$fs_uuid" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "Could not read a filesystem UUID from $device" >&2; exit 78; }
log "Filesystem UUID: $fs_uuid"

install -d -m 0755 "$mount_point"

# fstab is keyed by UUID; rewrite only our own managed line so operator edits
# elsewhere are preserved.
fstab_marker="# edumatch-staging-data-volume"
if grep -qF "$fstab_marker" /etc/fstab; then
  sed -i "\|^UUID=.*[[:space:]]${mount_point}[[:space:]]|d" /etc/fstab
fi
printf 'UUID=%s %s ext4 defaults,nofail,x-systemd.device-timeout=120 0 2 %s\n' \
  "$fs_uuid" "$mount_point" "$fstab_marker" >> /etc/fstab

if mountpoint -q "$mount_point"; then
  current=$(findmnt -n -o UUID --target "$mount_point")
  if [[ "$current" == "$fs_uuid" ]]; then
    log "$mount_point already mounted from the expected filesystem"
  else
    echo "Mount point $mount_point is already backed by a different filesystem ($current)" >&2
    exit 78
  fi
else
  log "Mounting $mount_point"
  mount "$mount_point"
fi

systemctl daemon-reload
mountpoint -q "$mount_point" || { echo "$mount_point is not mounted after bootstrap" >&2; exit 78; }

# Record the UUID for the reviewed install step (bootstrap compose + secrets).
install -d -m 0700 /opt/edumatch
printf '%s\n' "$fs_uuid" > /opt/edumatch/data-volume-uuid
printf '%s\n' "$data_volume_id" > /opt/edumatch/data-volume-id

echo "DATA_VOLUME_READY volume=$data_volume_id device=$device uuid=$fs_uuid mount=$mount_point"
