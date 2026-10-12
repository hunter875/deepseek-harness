#!/bin/bash
set -euo pipefail
# Operator bootstrap after audited AMI/provisioning. No generic SSM observer tool.
source_dir=${1:?reviewed cloud directory}
compose_binary=${2:?verified Compose plugin binary}
compose_sha256=${3:?approved SHA256}
data_volume_id=${4:?Terraform data volume ID}
# The filesystem UUID is established by bootstrap-data-volume.sh, which is the
# only step allowed to create a filesystem. Reuse it here so this script can
# never format a populated volume.
data_uuid=${5:-$(cat /opt/edumatch/data-volume-uuid 2>/dev/null || true)}
[[ "$data_volume_id" =~ ^vol-[a-f0-9]+$ ]] && [[ "$compose_sha256" =~ ^[a-f0-9]{64}$ ]]
[[ "$data_uuid" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "Run bootstrap-data-volume.sh first" >&2; exit 78; }
printf '%s  %s\n' "$compose_sha256" "$compose_binary" | sha256sum --check -
mountpoint -q /srv/edumatch
[[ "$(findmnt -n -o UUID --target /srv/edumatch)" == "$data_uuid" ]]
device=$(findmnt -n -o SOURCE --target /srv/edumatch)
lsblk -n -o SERIAL "$device" | tr -d '-' | grep -Fx "${data_volume_id//-/}" >/dev/null
install -D -m 0755 "$compose_binary" /usr/local/lib/docker/cli-plugins/docker-compose
for script in bootstrap-data-volume.sh release.sh release_guard.py observe_release.py backup.sh restore-drill.sh max-session.sh tls-self-signed.sh; do
  install -m 0755 "$source_dir/$script" "/opt/edumatch/bin/$script"
done
cat > /etc/systemd/system/edumatch-max-session.service <<'UNIT'
[Unit]
Description=Stop staging after its authorized bounded session
[Service]
Type=oneshot
ExecStart=/opt/edumatch/bin/max-session.sh
UNIT
cat > /etc/systemd/system/edumatch-max-session.timer <<'UNIT'
[Unit]
Description=Check staging session lease
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now edumatch-max-session.timer
echo 'Bootstrap installed; populate runtime secrets/TLS and run readiness/restore drills before live gate'
