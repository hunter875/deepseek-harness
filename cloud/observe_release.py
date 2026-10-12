import datetime
import json
import pathlib
import subprocess
import sys

directory, envfile = sys.argv[1:]
manifest = json.loads((pathlib.Path(directory) / "manifest.json").read_text())
compose = ["docker", "compose", "--project-name", "edumatch-staging", "--env-file", envfile, "-f", str(pathlib.Path(directory) / "compose.yml")]
services = {}
for name in ["auth-service", "scholarship-service", "chat-service", "matching-service", "frontend", "api-gateway", "matching-consumer"]:
    container = subprocess.check_output(compose + ["ps", "-q", name], text=True).strip()
    assert container and "\n" not in container
    data = json.loads(subprocess.check_output(["docker", "inspect", container], text=True))[0]
    wanted = manifest["images"]["matching-service" if name == "matching-consumer" else name]
    image_data = json.loads(subprocess.check_output(["docker", "image", "inspect", wanted], text=True))[0]
    assert data["Image"] == image_data["Id"]
    assert image_data["Config"]["Labels"]["org.opencontainers.image.revision"] == manifest["sourceRevision"]
    assert data["State"]["Running"]
    if name != "matching-consumer":
        assert data["State"].get("Health", {}).get("Status") == "healthy", f"No readiness evidence for {name}"
    services[name] = {"desiredDigest": wanted.split("@", 1)[1], "observedDigest": wanted.split("@", 1)[1], "reconciled": True}
print(json.dumps({"schemaVersion": "1.0", "targetRef": "aws-staging", "accountId": manifest["accountId"], "region": manifest["region"], "releaseId": manifest["releaseId"], "sourceRevision": manifest["sourceRevision"], "migrationDigest": manifest["migrationDigest"], "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "services": services, "status": "RECONCILED_PENDING_EXTERNAL_SMOKE", "rollback": "code-only"}))
