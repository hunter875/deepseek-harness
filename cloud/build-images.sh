#!/bin/bash
# Build all six EduMatch images on the instance, stamped with the source
# revision. Runs sequentially so peak memory stays well inside 8 GiB.
#
# The revision is validated before use: a label value carrying whitespace or a
# stray escape renders as "\n<sha>\n" in the image metadata and makes the host's
# exact string comparison against the release manifest fail, which looks like a
# wrong build rather than a formatting bug.
set -euo pipefail
REV=${1:?source revision}
REV=${REV//[[:space:]]/}
[[ "$REV" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid revision: [$REV]" >&2; exit 64; }
cd /opt/edumatch/build/edumatch

M=maven@sha256:80034909d9a9f0b89d3d2c583f07f3b7650309bc4e6b886ad5b860b9e1bfa439
J=eclipse-temurin@sha256:bec16bceecb1a89defa333c77ac76d29a6b0d59fcb4f50218b476efa68e30bb4
PY=python@sha256:44ff437bba879d4941b710a369a8f19266aea34b29002807f0c487fabc9eec9b
NODE=node@sha256:aa83e8f13963f17f7f6bd497085112bf12ea6f20b4b826d9b33f2d99594325b6
NGINX=nginx@sha256:0530961ff0592b58c10f767535cc0abdfccf9e389ff7cc90f87320c1bc7e8506
LABEL="org.opencontainers.image.revision=$REV"

build() {
  local name=$1; shift
  echo "=== building $name ==="
  docker build --label "$LABEL" -t "edumatch-local/$name:latest" "$@" . 2>&1 | tail -3
}

build matching-service -f /opt/edumatch/build/cloud/Dockerfile.matching --build-arg PYTHON_BASE=$PY
for s in auth-service scholarship-service chat-service; do
  build "$s" -f /opt/edumatch/build/cloud/Dockerfile.java --build-arg SERVICE=$s --build-arg MAVEN_BASE=$M --build-arg JAVA_BASE=$J
done
build api-gateway -f /opt/edumatch/build/cloud/Dockerfile.gateway --build-arg NGINX_BASE=$NGINX
build frontend -f /opt/edumatch/build/cloud/Dockerfile.frontend --build-arg NODE_BASE=$NODE --build-arg PUBLIC_ORIGIN=https://edumatch.staging.local

echo "=== labels (must be exactly $REV) ==="
for s in auth-service scholarship-service chat-service matching-service frontend api-gateway; do
  printf '%s ' "$s"
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "edumatch-local/$s:latest"
done
echo "BUILD_ALL_DONE"

