#!/usr/bin/env bash
# Tests the negative cases in cloud/release_guard.py.
#
# The guard is the last check before release.sh pulls and starts containers, so
# a guard that accepts a broken release is worse than no guard. Each case
# mutates one property of a known-good release and asserts the guard refuses.
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$script_dir/.." && pwd)
guard="$root/cloud/release_guard.py"

for tool in python3; do command -v "$tool" >/dev/null || { echo "SKIP: $tool unavailable"; exit 0; }; done
python3 -c "import yaml" 2>/dev/null || { echo "SKIP: PyYAML unavailable"; exit 0; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0; fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1: expected [$3] got [$2]"; fail=$((fail+1)); fi; }

rev="0123456789abcdef0123456789abcdef01234567"
release_id="$rev-1"
account="741269129377"

build_release() { # directory
  local dir=$1
  mkdir -p "$dir"
  python3 - "$dir" "$rev" "$release_id" "$account" <<'PY'
import hashlib, json, pathlib, sys
d, rev, rid, account = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
apps = ["auth-service","scholarship-service","chat-service","matching-service","frontend","api-gateway"]
platform = {"auth-db":"mysql","scholarship-db":"mysql","chat-db":"mysql","matching-db":"postgres","redis":"redis","rabbitmq":"rabbitmq"}
images = {s: f"{account}.dkr.ecr.ap-southeast-1.amazonaws.com/edumatch-staging/{s}@sha256:" + "a"*64 for s in apps}
images.update({k: f"{v}@sha256:" + "b"*64 for k, v in platform.items()})

services = {}
for s in ["auth-service","scholarship-service","chat-service","matching-service","matching-consumer"]:
    # Mirrors what the real generator emits: the Spring consumers receive a
    # file:-scheme path (a bare absolute path resolves as a classpath resource)
    # and the JWT fallback secret comes from the runtime env, never inline.
    env = {"APP_VERSION": rev, "DEPLOY_ENVIRONMENT": "aws-staging", "APP_JWT_REQUIRE_RSA": "true", "JWT_REQUIRE_RSA": "true",
           "APP_JWT_RSA_PUBLIC_KEY_PATH": "file:/run/secrets/jwt-public.pem", "JWT_PUBLIC_KEY_PATH": "/run/secrets/jwt-public.pem",
           "APP_JWT_SECRET": "${EDUMATCH_JWT_FALLBACK_SECRET:?Set EDUMATCH_JWT_FALLBACK_SECRET in runtime .env}"}
    vols = ["/opt/edumatch/secrets/jwt-public.pem:/run/secrets/jwt-public.pem:ro"]
    if s == "auth-service":
        env["APP_AUTH_COOKIE_SECURE"] = "true"
        env["APP_JWT_RSA_PRIVATE_KEY_PATH"] = "file:/run/secrets/jwt-private.pem"
        vols.append("/opt/edumatch/secrets/jwt-private.pem:/run/secrets/jwt-private.pem:ro")
    services[s] = {"image": images.get(s, images["matching-service"]), "environment": env, "volumes": vols}
services["frontend"] = {"image": images["frontend"], "environment": {"NEXT_PUBLIC_API_GATEWAY": "https://edumatch.staging.local"}}
services["api-gateway"] = {"image": images["api-gateway"], "ports": ["443:443"], "volumes": ["./nginx.conf:/etc/nginx/nginx.conf:ro"]}
for k, v in platform.items():
    services[k] = {"image": images[k]}

compose = "name: edumatch-staging\nservices:\n" + "".join(
    f"  {name}:\n    image: {spec['image']}\n" +
    ("    ports:\n" + "".join(f"      - {p}\n" for p in spec["ports"]) if "ports" in spec else "") +
    ("    volumes:\n" + "".join(f"      - {v}\n" for v in spec["volumes"]) if "volumes" in spec else "") +
    ("    environment:\n" + "".join(f"      {k}: {json.dumps(v)}\n" for k, v in spec.get("environment", {}).items()) if "environment" in spec else "")
    for name, spec in services.items())
compose += "networks:\n  app:\n    driver: bridge\n"
nginx = "server {\n  listen 443 ssl;\n  ssl_certificate /etc/nginx/tls/fullchain.pem;\n}\n"
(d / "compose.yml").write_text(compose)
(d / "nginx.conf").write_text(nginx)
canonical = json.dumps({"compose": compose, "nginx": nginx}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
manifest = {"schemaVersion": "1.0", "environment": "aws-staging", "region": "ap-southeast-1", "accountId": account,
            "releaseId": rid, "sourceRevision": rev, "migrationDigest": "c"*64, "tlsDomain": "edumatch.staging.local",
            "configVersion": hashlib.sha256(canonical.encode()).hexdigest(), "images": images, "expectedPreviousRelease": None}
(d / "manifest.json").write_text(json.dumps(manifest))
PY
}

run_guard() { # dir [operation]
  python3 "$guard" "$1" "$work/no-current" "${2:-deploy}" 2>&1 || true
}

# Every mutation keeps the release-ID-named directory (otherwise the guard
# fails on the identity check first) and re-seals configVersion afterwards
# (otherwise it fails on the digest binding first). mutate() therefore applies
# an edit and re-seals, so the assertion under test is the one that fires.
mutate() { # name  <python-edit-file>
  mkdir -p "$work/$1/$release_id"
  cp -r "$good/." "$work/$1/$release_id/"
  mutate_dir="$work/$1/$release_id"
  python3 "$reseed" "$mutate_dir" "$2"
  echo "$mutate_dir"
}

# reseed.py: apply an edit script, then recompute the manifest configVersion so
# only the property under test can trigger the guard.
cat > "$work/reseed.py" <<'PY'
import hashlib, json, pathlib, runpy, sys
directory = pathlib.Path(sys.argv[1])
edit = pathlib.Path(sys.argv[2])
runpy.run_path(str(edit), init_globals={"directory": directory})
compose = (directory / "compose.yml").read_text()
nginx = (directory / "nginx.conf").read_text()
canonical = json.dumps({"compose": compose, "nginx": nginx}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
manifest_path = directory / "manifest.json"
manifest = json.loads(manifest_path.read_text())
manifest["configVersion"] = hashlib.sha256(canonical.encode()).hexdigest()
manifest_path.write_text(json.dumps(manifest))
PY
reseed="$work/reseed.py"

echo "release_guard.py negative tests"

# 0. The generated known-good release must pass.
good="$work/good/$release_id"
build_release "$good"
out=$(run_guard "$good")
check "known-good release accepted" "$(grep -c 'Traceback' <<<"$out")" "0"

# 1. A service that must verify tokens but lacks the public key mount.
#    Scoped to one named block: the same mount line appears under every service,
#    so a global replace(...,1) would hit the first service in the file and
#    leave the one under test untouched.
cat > "$work/edit1.py" <<'PY'
lines = (directory / "compose.yml").read_text().split("\n")
out, in_target = [], False
for line in lines:
    if line.startswith("  ") and not line.startswith("    ") and line.rstrip().endswith(":"):
        in_target = line.strip() == "auth-service:"
    if in_target and line.strip() == "- /opt/edumatch/secrets/jwt-public.pem:/run/secrets/jwt-public.pem:ro":
        continue
    out.append(line)
assert len(out) < len(lines), "mutation did not remove the public key mount"
(directory / "compose.yml").write_text("\n".join(out))
PY
dir=$(mutate missing-public-mount "$work/edit1.py")
out=$(run_guard "$dir")
check "missing public key mount refused" "$([[ $(grep -c 'missing the read-only public key mount' <<<"$out") -ge 1 ]] && echo yes || echo no)" "yes"

# 2. auth-service without the private key mount.
cat > "$work/edit2.py" <<'PY'
p = directory / "compose.yml"
p.write_text(p.read_text().replace("      - /opt/edumatch/secrets/jwt-private.pem:/run/secrets/jwt-private.pem:ro\n", "", 1))
PY
dir=$(mutate missing-private-mount "$work/edit2.py")
out=$(run_guard "$dir")
check "missing private key mount refused" "$([[ $(grep -c 'read-only private key mount' <<<"$out") -ge 1 ]] && echo yes || echo no)" "yes"

# 3. An inline PEM environment variable must be rejected.
cat > "$work/edit3.py" <<'PY'
p = directory / "compose.yml"
# Insert a raw PEM-valued key next to the path key. The fixture renders string
# values quoted, so the needle must include the quotes.
text = p.read_text()
needle = '      APP_JWT_RSA_PUBLIC_KEY_PATH: "file:/run/secrets/jwt-public.pem"\n'
assert needle in text, "fixture shape changed; update this mutation"
p.write_text(text.replace(needle, '      APP_JWT_RSA_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----"\n' + needle, 1))
PY
dir=$(mutate inline-pem "$work/edit3.py")
out=$(run_guard "$dir")
check "inline PEM env refused" "$([[ $(grep -c 'inline PEM value' <<<"$out") -ge 1 ]] && echo yes || echo no)" "yes"

# 4. A public database port must be rejected.
cat > "$work/edit4.py" <<'PY'
p = directory / "compose.yml"
p.write_text(p.read_text().replace("  auth-db:\n", "  auth-db:\n    ports:\n      - \"3306:3306\"\n", 1))
PY
dir=$(mutate public-db-port "$work/edit4.py")
out=$(run_guard "$dir")
check "public db port refused" "$(grep -c '3306:3306' <<<"$out")" "1"

# 5. Missing TLS in nginx must be rejected.
cat > "$work/edit5.py" <<'PY'
(directory / "nginx.conf").write_text("server { listen 80; }\n")
PY
dir=$(mutate missing-tls "$work/edit5.py")
out=$(run_guard "$dir")
check "missing TLS refused" "$(grep -c 'ssl_certificate' <<<"$out")" "1"

# 6. A tampered compose file with a stale configVersion must be rejected.
cat > "$work/edit6.py" <<'PY'
p = directory / "compose.yml"
p.write_text(p.read_text() + "\n# tampered\n")
PY
dir=$(mutate tampered-compose "$work/edit6.py")
# Re-sealing is what the edit above did; undo only the digest to model a
# release whose config was edited after the manifest was signed.
python3 - "$dir" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]) / "manifest.json"
m = json.loads(p.read_text())
m["configVersion"] = "0" * 64
p.write_text(json.dumps(m))
PY
out=$(run_guard "$dir")
check "config digest binding enforced" "$(grep -c 'configVersion' <<<"$out")" "1"

# 7. An app image outside the bound ECR repository must be rejected.
cat > "$work/edit7.py" <<'PY'
import json
p = directory / "manifest.json"
m = json.loads(p.read_text())
m["images"]["frontend"] = "docker.io/evil/frontend@sha256:" + "d" * 64
p.write_text(json.dumps(m))
PY
dir=$(mutate foreign-image "$work/edit7.py")
out=$(run_guard "$dir")
check "foreign registry image refused" "$([[ $(grep -c 'outside the bound ECR repository' <<<"$out") -ge 1 ]] && echo yes || echo no)" "yes"

# 8. A directory whose name differs from the release ID must be rejected.
mkdir -p "$work/wrong-name-dir"
cp -r "$good/." "$work/wrong-name-dir/"
out=$(run_guard "$work/wrong-name-dir")
check "release id / directory mismatch refused" "$(grep -c 'AssertionError' <<<"$out")" "1"

echo ""
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
