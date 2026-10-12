import hashlib
import json
import pathlib
import re
import sys

directory, current, operation = map(str, sys.argv[1:])
directory = pathlib.Path(directory)
release = json.loads((directory / "manifest.json").read_text())
assert release["environment"] == "aws-staging"
assert release["region"] == "ap-southeast-1"
assert re.fullmatch(r"[a-f0-9]{40}-[0-9]+", release["releaseId"])
assert re.fullmatch(r"[a-f0-9]{40}", release["sourceRevision"])
# The host compares the manifest revision against the OCI revision label baked
# into each image. A build that embeds whitespace in the label (seen live as
# "\n<sha>\n") causes a false mismatch, so reject any manifest whose revision is
# not already exactly the 40 hex characters.
assert release["sourceRevision"] == release["sourceRevision"].strip(), "sourceRevision carries surrounding whitespace"
assert release["releaseId"] == directory.name
assert set(release["images"]) == {"auth-service", "scholarship-service", "chat-service", "matching-service", "frontend", "api-gateway", "auth-db", "scholarship-db", "chat-db", "matching-db", "redis", "rabbitmq"}
for name, image in release["images"].items():
    assert re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}", image)
    if name in {"auth-service", "scholarship-service", "chat-service", "matching-service", "frontend", "api-gateway"}:
        assert image.startswith(f'{release["accountId"]}.dkr.ecr.ap-southeast-1.amazonaws.com/edumatch-staging/{name}@'), f"app image is outside the bound ECR repository: {name}"
compose = (directory / "compose.yml").read_text()
nginx = (directory / "nginx.conf").read_text()
canonical = json.dumps({"compose": compose, "nginx": nginx}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
assert hashlib.sha256(canonical.encode()).hexdigest() == release["configVersion"]
previous_file = pathlib.Path(current) / "manifest.json"
if previous_file.exists():
    previous = json.loads(previous_file.read_text())
    assert previous["accountId"] == release["accountId"]
    if operation == "rollback":
        assert previous["migrationDigest"] == release["migrationDigest"], "Separate approved data recovery/compatibility plan required"
    else:
        assert previous["releaseId"] == release["expectedPreviousRelease"], "Current release changed"
else:
    assert not release["expectedPreviousRelease"]
assert "build:" not in compose and "container_name:" not in compose
assert "6379:6379" not in compose and "3306:3306" not in compose
assert "443:443" in compose and "ssl_certificate" in nginx

# RSA verification is mandatory outside local. A service told to read a key
# path without the matching read-only mount would only fail at startup, so the
# pairing is enforced here, before anything is pulled or started. Parsing goes
# through a real YAML loader so folded scalars and quoting cannot hide a
# missing mount.
PUBLIC_SOURCE = "/opt/edumatch/secrets/jwt-public.pem:/run/secrets/jwt-public.pem:ro"
PRIVATE_SOURCE = "/opt/edumatch/secrets/jwt-private.pem:/run/secrets/jwt-private.pem:ro"
PUBLIC_TARGET = "/run/secrets/jwt-public.pem"
PRIVATE_TARGET = "/run/secrets/jwt-private.pem"
try:
    import yaml
    parsed = yaml.safe_load(compose)
except ImportError:  # pragma: no cover - the host image ships PyYAML for Compose
    parsed = None
assert parsed and isinstance(parsed.get("services"), dict), "Compose must be valid YAML with a services map"
# The audited Compose is written for a local stack whose service hostnames carry
# a "-test" suffix that does not exist in the deployment network. Any survivor
# makes a service call a host that cannot resolve; chat-service did exactly that
# and returned 503 on every chat request.
for name, spec in parsed["services"].items():
    for key, value in (spec.get("environment") or {}).items():
        assert "-test" not in str(value), f"{name}.{key} still points at a local-only '-test' host"
for service in ("auth-service", "scholarship-service", "chat-service", "matching-service", "matching-consumer"):
    spec = parsed["services"].get(service)
    assert spec, f"{service} is missing a Compose service block"
    volumes = [str(v) for v in (spec.get("volumes") or [])]
    environment = spec.get("environment") or {}
    assert PUBLIC_SOURCE in volumes, f"{service} is missing the read-only public key mount"
    public_path = environment.get("APP_JWT_RSA_PUBLIC_KEY_PATH") or environment.get("JWT_PUBLIC_KEY_PATH") or ""
    assert PUBLIC_TARGET in public_path, f"{service} does not consume the mounted public key"
    # Spring injects the Java property as a `Resource`. A bare absolute path is
    # resolved by DefaultResourceLoader as a classpath resource, which fails at
    # startup with "Could not open ServletContext resource", so the file: scheme
    # is mandatory for the property that is injected that way.
    if environment.get("APP_JWT_RSA_PUBLIC_KEY_PATH"):
        assert public_path.startswith("file:"), f"{service} APP_JWT_RSA_PUBLIC_KEY_PATH needs a file: scheme"
    # The inline-PEM form must be absent. Membership is tested against exact
    # keys: a substring test would always match APP_JWT_RSA_PUBLIC_KEY_PATH.
    assert "APP_JWT_RSA_PUBLIC_KEY" not in environment, f"{service} still expects an inline PEM value (APP_JWT_RSA_PUBLIC_KEY)"
    assert "JWT_PUBLIC_KEY" not in environment, f"{service} still expects an inline PEM value (JWT_PUBLIC_KEY)"
auth_spec = parsed["services"].get("auth-service", {})
auth_volumes = [str(v) for v in (auth_spec.get("volumes") or [])]
auth_env = auth_spec.get("environment") or {}
assert PRIVATE_SOURCE in auth_volumes, "auth-service is missing the read-only private key mount"
private_path = auth_env.get("APP_JWT_RSA_PRIVATE_KEY_PATH") or ""
assert PRIVATE_TARGET in private_path, "auth-service does not consume the mounted private key"
assert private_path.startswith("file:"), "auth-service APP_JWT_RSA_PRIVATE_KEY_PATH needs a file: scheme"
assert "APP_JWT_RSA_PRIVATE_KEY" not in auth_env, "auth-service still expects an inline private PEM value (APP_JWT_RSA_PRIVATE_KEY)"
