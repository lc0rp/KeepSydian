"""Fixed beta.8 observations only: no release engine, shell, build or mutation API.

GitHub subprocess arguments always specify GET and an exact allowlisted path.
Cloud and application transport has no method/body argument and rejects redirects.
The existing cloud identity is write-capable; safety comes from the reviewed,
immutable GET-only program, not a claim that IAM has become read-only.
"""

from __future__ import annotations

import argparse
import base64
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import time
from typing import Any
from urllib.request import HTTPRedirectHandler, Request, build_opener

from restore_release_artifact import restore

CONTRACT = json.loads(
    (Path(__file__).parent / "fixtures/beta8-validation-contract.json").read_text()
)
SIDE = CONTRACT["side"]
SERVER = CONTRACT.get("server", {})
CLIENT = CONTRACT.get("client", {})
REVISION = "keepsidianserver-beta8-bc5f84b"
IMAGE = "us-central1-docker.pkg.dev/lc0rp-labs/cloud-run-source-deploy/keepsidianserver@sha256:d29e18103e9e8cfe03bf62257fa4406f4828c56e3ed5bd947ef9678c668730bf"
DIGEST = IMAGE.split("@", 1)[1]
RUN_BASE = "https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/lc0rp-labs"
SERVICE_URL = RUN_BASE + "/services/keepsidianserver"
REVISION_URL = RUN_BASE + "/revisions/" + REVISION
MANIFEST_URL = (
    "https://us-central1-docker.pkg.dev/v2/lc0rp-labs/cloud-run-source-deploy/keepsidianserver/manifests/"
    + DIGEST
)
TAGS = ("sv0-1-0-beta-8", "v2-1-0-beta-8")
BASES = tuple(
    "https://" + tag + "---keepsidianserver-i55qr5tvea-uc.a.run.app" for tag in TAGS
)
PATHS = ("/keep/sync/capabilities", "/subscribe", "/keep/enrich/local/capabilities")
OUTPUT_ANNOTATIONS = {
    "run.googleapis.com/client-name",
    "run.googleapis.com/client-version",
    "run.googleapis.com/operation-id",
    "run.googleapis.com/urls",
    "run.googleapis.com/ingress-status",
    "serving.knative.dev/creator",
    "serving.knative.dev/lastModifier",
    "run.googleapis.com/build-id",
    "run.googleapis.com/build-image-uri",
    "run.googleapis.com/build-name",
    "run.googleapis.com/build-source-location",
}
GITHUB_BYTES = 32 * 1024 * 1024
GITHUB_SECONDS = 30


def bounded_gh_get(args: list[str]) -> bytes:
    """Stream stdout with a byte/deadline bound; never expose stderr or tokens."""
    allowed = set()
    for side in (SIDE,):
        reader = Reads(side)
        allowed |= reader.json_paths | reader.binary_paths
    if (
        len(args) not in (5, 7)
        or args[:4] != ["gh", "api", "--method", "GET"]
        or args[4] not in allowed
        or (len(args) == 7 and args[5:] != ["-H", "Accept: application/octet-stream"])
    ):
        raise ValueError("Only frozen GitHub GET commands are permitted")
    payload = bytearray()
    deadline = time.monotonic() + GITHUB_SECONDS
    with subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ) as process:
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise RuntimeError("GitHub validation GET deadline exhausted")
                    chunk = os.read(
                        process.stdout.fileno(),
                        min(65536, GITHUB_BYTES - len(payload) + 1),
                    )
                    if not chunk:
                        break
                    payload.extend(chunk)
                    if len(payload) > GITHUB_BYTES:
                        raise RuntimeError(
                            "GitHub validation GET exceeds byte allowance"
                        )
                remaining = deadline - time.monotonic()
                if remaining <= 0 or process.wait(timeout=remaining) != 0:
                    raise RuntimeError("Canonical GitHub validation GET failed")
        except Exception:
            process.kill()
            process.wait()
            raise RuntimeError(
                "Canonical GitHub GET failed or exceeded byte/time allowance"
            ) from None
    return bytes(payload)


def digest(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: Any) -> None:
        raise RuntimeError("Validation forbids HTTP redirects")


class Reads:
    """Closed GET transport; tokens cannot be sent to a caller-supplied URL."""

    def __init__(self, side: str) -> None:
        if side != SIDE:
            raise ValueError("Fixed validation side required")
        self.side = side
        self.started = time.monotonic()
        self.application_gets = 0
        self.cloud_gets = 0
        self.github_gets = 0
        proof = CONTRACT[side]
        prefix = f"repos/{proof['repository']}"
        self.json_paths = {
            f"{prefix}/actions/runs/{proof['run_id']}",
            f"{prefix}/actions/artifacts/{proof['artifact_id']}",
        }
        self.binary_paths = {f"{prefix}/actions/artifacts/{proof['artifact_id']}/zip"}
        if side == "client":
            self.json_paths |= {
                f"{prefix}/releases/{CLIENT['release_id']}",
                f"{prefix}/git/ref/tags/{CLIENT['tag']}",
            }
            self.binary_paths |= {
                f"{prefix}/releases/assets/{asset['id']}"
                for asset in CLIENT["assets"].values()
            }

    def deadline(self) -> None:
        if time.monotonic() - self.started > 480:
            raise RuntimeError("Eight-minute validation deadline exhausted")

    def github(self, path: str, binary: bool = False) -> Any:
        self.deadline()
        if (
            path not in (self.binary_paths if binary else self.json_paths)
            or self.github_gets >= 8
        ):
            raise RuntimeError(
                "GitHub read is outside the fixed validation allowlist/budget"
            )
        self.github_gets += 1
        args = ["gh", "api", "--method", "GET", path]
        if binary and "/releases/assets/" in path:
            args += ["-H", "Accept: application/octet-stream"]
        payload = bounded_gh_get(args)
        return payload if binary else json.loads(payload)

    def get(self, url: str) -> bytes:
        self.deadline()
        headers = {}
        if self.side == "server" and url in (SERVICE_URL, REVISION_URL, MANIFEST_URL):
            if self.cloud_gets >= 5:
                raise RuntimeError("Five cloud metadata GET allowance exhausted")
            self.cloud_gets += 1
            token = os.environ.get("ACCESS_TOKEN", "")
            if not token:
                raise RuntimeError("Fresh hosted OIDC access token required")
            if url == MANIFEST_URL:
                headers["Authorization"] = (
                    "Basic "
                    + base64.b64encode(("oauth2accesstoken:" + token).encode()).decode()
                )
                headers["Accept"] = (
                    "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json"
                )
            else:
                headers["Authorization"] = "Bearer " + token
            limit = 1024 * 1024
        elif url in {
            base + path
            for base in (BASES if self.side == "server" else BASES[1:])
            for path in PATHS
        }:
            if self.application_gets >= (10 if self.side == "server" else 5):
                raise RuntimeError("Application GET allowance exhausted")
            self.application_gets += 1
            limit = 65536
        else:
            raise RuntimeError("HTTP read is outside the fixed validation allowlist")
        # No method or body parameter is exposed anywhere in this transport.
        request = Request(url, headers=headers, method="GET")
        try:
            with build_opener(NoRedirect()).open(request, timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError("Unexpected validation HTTP status")
                payload = response.read(limit + 1)
        except Exception:
            raise RuntimeError(
                "Allowlisted validation GET failed; no repair attempted"
            ) from None
        self.deadline()
        if len(payload) > limit:
            raise RuntimeError("Validation response exceeds byte allowance")
        return payload


def restore_fixed(side: str, destination: Path, reads: Reads) -> dict[str, Any]:
    proof = CONTRACT[side]
    origin = restore(
        proof["repository"],
        proof["run_id"],
        proof["artifact_id"],
        proof["head_sha"],
        proof["core"],
        proof["artifact_prefix"],
        set(proof["files"]),
        set(proof["files"]),
        destination,
        reads.github,
    )
    for key in ("archive_digest", "files", "attempt"):
        if origin[key] != proof[key]:
            raise RuntimeError(
                "Original beta.8 evidence identity differs from the frozen contract"
            )
    return origin


def routes(values: list[dict[str, Any]]) -> list[tuple[str, str, int]]:
    result = []
    for value in values:
        if value.get("latestRevision") or not value.get("revisionName"):
            raise RuntimeError("Validation requires immutable revision routes")
        result.append(
            (value.get("tag", ""), value["revisionName"], value.get("percent", 0))
        )
    if len(result) != len(set(result)):
        raise RuntimeError("Duplicate route in observed state")
    return sorted(result)


def state_profile(service: dict[str, Any]) -> dict[str, Any]:
    template = deepcopy(service["spec"]["template"])
    template["metadata"]["annotations"] = {
        k: v
        for k, v in template["metadata"].get("annotations", {}).items()
        if k not in OUTPUT_ANNOTATIONS
    }
    return {
        "template": template,
        "annotations": {
            k: v
            for k, v in service["metadata"].get("annotations", {}).items()
            if k not in OUTPUT_ANNOTATIONS
        },
        "labels": service["metadata"].get("labels", {}),
        "traffic": routes(service["spec"]["traffic"]),
    }


def validate_state(service: dict[str, Any], revision: dict[str, Any]) -> None:
    expected = deepcopy(SERVER["expected"])
    expected["traffic"] = routes(expected["traffic"])
    if (
        state_profile(service) != expected
        or routes(service["status"]["traffic"]) != expected["traffic"]
        or revision["metadata"].get("name") != REVISION
        or revision["spec"] != expected["template"]["spec"]
        or revision["status"].get("imageDigest") != IMAGE
        or not any(
            c.get("type") == "Ready" and c.get("status") == "True"
            for c in revision["status"].get("conditions", [])
        )
    ):
        raise RuntimeError(
            "Beta.8 mapped state/runtime/image drift; validation cannot repair it"
        )


def smoke(reads: Reads, bases: tuple[str, ...]) -> None:
    epochs, enrichment = [], []
    for base in bases:
        for path in (PATHS[0], PATHS[1], PATHS[0], PATHS[2], PATHS[2]):
            payload = reads.get(base + path)
            if path == PATHS[0]:
                value = json.loads(payload)
                if (
                    set(value) != {"replay_version", "replay_epoch"}
                    or type(value["replay_version"]) is not int
                    or value["replay_version"] != 1
                    or not re.fullmatch(r"[0-9a-f]{32}", str(value["replay_epoch"]))
                ):
                    raise RuntimeError("Unexpected replay capability")
                epochs.append(value["replay_epoch"])
            elif path == PATHS[2]:
                value = json.loads(payload)
                if (
                    set(value) != {"version", "epoch", "issued_at_ms"}
                    or type(value["version"]) is not int
                    or value["version"] != 1
                    or type(value["issued_at_ms"]) is not int
                    or value["issued_at_ms"] < 0
                    or not re.fullmatch(r"[0-9a-f]{32}", str(value["epoch"]))
                ):
                    raise RuntimeError("Unexpected enrichment capability")
                enrichment.append(value["epoch"])
    if len(set(epochs)) != 1 or len(set(enrichment)) != 1:
        raise RuntimeError("Capability epoch changed; no automatic retry")


def validate(side: str, destination: Path, reads: Reads) -> dict[str, Any]:
    if side != SIDE or reads.side != SIDE:
        raise ValueError("Validator is restricted to its own repository")
    origin = restore_fixed(side, destination / "recovered", reads)
    if side == "server":
        proof = json.loads(
            (destination / "recovered/image-release-receipt.json").read_text()
        )
        if proof != SERVER["image_receipt"]:
            raise RuntimeError("Original image receipt mismatch")
        service, revision = (
            json.loads(reads.get(SERVICE_URL)),
            json.loads(reads.get(REVISION_URL)),
        )
        validate_state(service, revision)
        manifest_bytes = reads.get(MANIFEST_URL)
        manifest = json.loads(manifest_bytes)
        if (
            digest(manifest_bytes) != DIGEST
            or manifest.get("config", {}).get("digest") != proof["config_digest"]
            or sum(layer["size"] for layer in manifest["layers"])
            + manifest["config"]["size"]
            != proof["compressed_bytes"]
        ):
            raise RuntimeError(
                "Immutable registry manifest differs from original push receipt"
            )
        smoke(reads, BASES)
        validate_state(
            json.loads(reads.get(SERVICE_URL)), json.loads(reads.get(REVISION_URL))
        )
    else:
        prefix = f"repos/{CLIENT['repository']}"
        ref = reads.github(f"{prefix}/git/ref/tags/{CLIENT['tag']}")
        if ref.get("object") != {
            "type": "commit",
            "sha": CLIENT["source"],
            "url": f"https://api.github.com/{prefix}/git/commits/{CLIENT['source']}",
        }:
            raise RuntimeError(
                "Published beta.8 source tag differs from the frozen target"
            )
        release = reads.github(f"{prefix}/releases/{CLIENT['release_id']}")
        if (
            release.get("id") != CLIENT["release_id"]
            or release.get("tag_name") != CLIENT["tag"]
            or release.get("draft") is not False
            or release.get("prerelease") is not True
            or len(release.get("assets", [])) != 3
        ):
            raise RuntimeError("Published beta.8 release identity/state mismatch")
        observed = {}
        for asset in release["assets"]:
            name = asset["name"]
            expected = CLIENT["assets"].get(name)
            if (
                expected is None
                or name in observed
                or any(asset.get(k) != v for k, v in expected.items())
            ):
                raise RuntimeError("Published asset identity/size/digest mismatch")
            payload = reads.github(
                f"{prefix}/releases/assets/{asset['id']}", binary=True
            )
            if (
                len(payload) != expected["size"]
                or digest(payload) != expected["digest"]
                or expected["digest"] != origin["files"][name]
            ):
                raise RuntimeError("Published bytes differ from the original artifact")
            observed[name] = expected["digest"]
        smoke(reads, BASES[1:])
    reads.deadline()
    result = {
        "status": "read-only beta.8 observations verified",
        "side": side,
        "origin": origin,
        "application_gets": reads.application_gets,
        "cloud_gets": reads.cloud_gets,
        "github_gets": reads.github_gets,
        "production_mutations": 0,
        "provider_calls": 0,
        "release_proof": False,
        "limitations": "Does not prove new deployment, tag-write permissions, mutation recovery or cross-repository handoff",
    }
    encoded = (json.dumps(result, indent=2) + "\n").encode()
    if (
        len(encoded) + (destination / "recovered/artifact-origin.json").stat().st_size
        > 65536
    ):
        raise RuntimeError("Combined validation receipt allowance exceeded")
    (destination / "validation-receipt.json").write_bytes(encoded)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("side", choices=(SIDE,))
    args = parser.parse_args()
    # No release plan, alternate source/artifact/URL, token, or write-mode input.
    if os.environ.get("KEEPSIDIAN_RELEASE_PLAN"):
        parser.error("Read-only beta.8 validation does not accept release plans")
    print(
        json.dumps(validate(args.side, Path("validation"), Reads(args.side)), indent=2)
    )
