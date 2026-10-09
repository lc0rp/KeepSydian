"""Native Cloud Build provenance and etag-protected client alias mapping.

No IAM writes, builds, deployment, tag repointing or arbitrary endpoints here.
Client-only releases use exactly the same verifier/mapper as paired releases.
"""

from __future__ import annotations
import argparse
import base64
import hashlib
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import time
from typing import Any, Callable
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

PROJECT = "lc0rp-labs"
PROJECT_NUMBER = "162887264002"
REGION = "us-central1"
SERVICE = "keepsidianserver"
RESOURCE = f"projects/{PROJECT}/locations/{REGION}/services/{SERVICE}"
RUN = "https://run.googleapis.com/v2/" + RESOURCE
IMAGE = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/{SERVICE}"
RUNTIME = "keepsidian-runtime@lc0rp-labs.iam.gserviceaccount.com"
BUILD_SA = f"projects/{PROJECT}/serviceAccounts/keepsidian-cloudbuild@{PROJECT}.iam.gserviceaccount.com"
TRIGGER = "43a37949-e2fa-4539-8bac-4404840f8c72"
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
SUFFIX = "---keepsidianserver-i55qr5tvea-uc.a.run.app"


V1 = "https://run.googleapis.com/apis/serving.knative.dev/v1/namespaces/" + PROJECT
PROFILE_SPEC_HASH = "bc732af944735aa9d1418618513fd07d457417dc0287558bf2e30cf3ea10230d"
PROFILE_ANNOTATIONS_HASH = (
    "89a8ab83f445fa3a8a8440a48a70f1b543505d026cdda47c4a67c91542bf7467"
)
SERVICE_ANNOTATIONS_HASH = (
    "c4262e4d0a744de3c9be36b83cac472e4540faa9c55200b4e11bfc44ea1b239c"
)
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


def fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def configured_annotations(value: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in value.items() if k not in OUTPUT_ANNOTATIONS}


def verify_runtime(read: Callable[..., Any], identity: dict[str, str]) -> None:
    revision = read(V1 + "/revisions/" + identity["revision"])
    spec = deepcopy(revision.get("spec", {}))
    containers = spec.get("containers", [])
    if len(containers) != 1 or containers[0].pop("image", None) != identity["image"]:
        raise RuntimeError("Runtime image/profile mismatch")
    if (
        fingerprint(spec) != PROFILE_SPEC_HASH
        or fingerprint(
            configured_annotations(revision.get("metadata", {}).get("annotations", {}))
        )
        != PROFILE_ANNOTATIONS_HASH
    ):
        raise RuntimeError("Full runtime resources/secrets/network profile mismatch")
    service = read(V1 + "/services/" + SERVICE)
    if (
        fingerprint(
            configured_annotations(service.get("metadata", {}).get("annotations", {}))
        )
        != SERVICE_ANNOTATIONS_HASH
    ):
        raise RuntimeError("Service ingress/network/billing profile mismatch")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: Any) -> None:
        raise RuntimeError("Redirect refused")


def request(url: str, token: str, body: dict[str, Any] | None = None) -> Any:
    build_pattern = (
        re.escape(
            f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/global/builds/"
        )
        + UUID
    )
    revision_pattern = (
        re.escape(RUN + "/revisions/") + r"keepsidianserver-b-[0-9a-f]{16}"
    )
    if body is None:
        allowed = (
            url == RUN
            or re.fullmatch(build_pattern, url)
            or re.fullmatch(revision_pattern, url)
            or url == V1 + "/services/" + SERVICE
            or re.fullmatch(
                re.escape(V1 + "/revisions/") + r"keepsidianserver-b-[0-9a-f]{16}", url
            )
        )
    else:
        allowed = (
            url == RUN + "?updateMask=traffic"
            and set(body) == {"name", "etag", "traffic"}
            and body["name"] == RESOURCE
            and isinstance(body["etag"], str)
            and bool(body["etag"])
            and isinstance(body["traffic"], list)
        )
    if not allowed:
        raise ValueError("Unapproved Google API operation")
    req = Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="PATCH" if body is not None else "GET",
    )
    try:
        with build_opener(NoRedirect()).open(req, timeout=20) as r:
            raw = r.read(2 * 1024 * 1024 + 1)
    except HTTPError as e:
        raise RuntimeError(
            f"Google API HTTP {e.code}; no permission widening"
        ) from None
    if len(raw) > 2 * 1024 * 1024:
        raise RuntimeError("Google response too large")
    return json.loads(raw)


def alias(tag: str, prefix: str) -> str:
    if not isinstance(tag, str) or not re.fullmatch(re.escape(prefix) + VERSION, tag):
        raise ValueError("Exact supported version tag required")
    value = tag.replace(".", "-")
    if len(value) > 63:
        raise ValueError("Cloud Run alias too long")
    return value


def build_url(build_id: str) -> str:
    if not re.fullmatch(UUID, build_id):
        raise ValueError("Exact native build UUID required")
    return f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/global/builds/{build_id}"


def build_identity(
    build: dict[str, Any], build_id: str, server_tag: str, successful: bool = True
) -> dict[str, str]:
    build_url(build_id)
    alias(server_tag, "sv")
    subs = build.get("substitutions", {})
    provenance = build.get("sourceProvenance", {})
    candidates = [
        provenance.get("resolvedRepoSource", {}).get("commitSha"),
        provenance.get("resolvedGitSource", {}).get("revision"),
        provenance.get("resolvedConnectedRepository", {}).get("revision"),
    ]
    commits = [x for x in candidates if x is not None]
    if (
        len(commits) != 1
        or not isinstance(commits[0], str)
        or not re.fullmatch(r"[0-9a-f]{40}", commits[0])
    ):
        raise RuntimeError("Missing or ambiguous native resolved source provenance")
    source = commits[0]
    resolved = provenance.get("resolvedGitSource")
    repo = provenance.get("resolvedRepoSource")
    # Accept only the reviewed first-generation GitHub repository, never names
    # supplied solely through user-overridable build substitutions.
    if resolved is not None:
        if resolved.get("url") not in (
            "https://github.com/lc0rp/KeepSidianServer",
            "https://github.com/lc0rp/KeepSidianServer.git",
        ) or resolved.get("dir", "") not in ("", "."):
            raise RuntimeError("Native Git source repository mismatch")
    elif repo is not None:
        if (
            repo.get("projectId") != PROJECT
            or repo.get("repoName") != "github_lc0rp_KeepSidianServer"
            or repo.get("dir", "") not in ("", ".")
        ):
            raise RuntimeError("Native repository source mismatch")
    else:
        raise RuntimeError("Unapproved native connection source type")
    if build.get("name") not in {
        f"projects/{PROJECT}/locations/global/builds/{build_id}",
        f"projects/{PROJECT_NUMBER}/locations/global/builds/{build_id}",
    }:
        raise RuntimeError("Native build resource name/location mismatch")
    if (
        build.get("id") != build_id
        or build.get("projectId") != PROJECT
        or build.get("buildTriggerId") != TRIGGER
        or build.get("serviceAccount") != BUILD_SA
        or build.get("status") not in (("SUCCESS",) if successful else ("WORKING",))
        or subs.get("TAG_NAME") != server_tag
        or subs.get("COMMIT_SHA") != source
        or subs.get("REPO_NAME", "").lower() != "keepsidianserver"
        or subs.get("REPO_FULL_NAME", "").lower() != "lc0rp/keepsidianserver"
    ):
        raise RuntimeError("Native build trigger/source/tag/identity/status mismatch")
    result = {
        "build_id": build_id,
        "server_tag": server_tag,
        "source": source,
        "revision": "keepsidianserver-b-" + build_id.replace("-", "")[:16],
    }
    if successful:
        images = build.get("results", {}).get("images", [])
        if (
            len(images) != 1
            or images[0].get("name") != IMAGE + ":build-" + build_id
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", images[0].get("digest", ""))
        ):
            raise RuntimeError(
                "Native build must record exactly the selected image digest"
            )
        result["image"] = IMAGE + "@" + images[0]["digest"]
    return result


def checkpoint(build: dict[str, Any]) -> dict[str, Any]:
    steps = build.get("steps", [])
    indices = [i for i, step in enumerate(steps) if step.get("id") == "capture-push"]
    if len(indices) != 1 or steps[indices[0]].get("status") != "SUCCESS":
        raise RuntimeError(
            "No completed native image checkpoint; do not rebuild automatically"
        )
    outputs = build.get("results", {}).get("buildStepOutputs", [])
    try:
        raw = base64.b64decode(outputs[indices[0]], validate=True)
        if len(raw) > 48000:
            raise ValueError("oversized")
        value = json.loads(raw)
    except (IndexError, ValueError, TypeError):
        raise RuntimeError("Missing or invalid durable native checkpoint") from None
    if (
        set(value)
        != {
            "schema",
            "root_build_id",
            "origin_build_id",
            "source",
            "image",
            "config_digest",
            "compressed_bytes",
            "baseline",
        }
        or value["schema"] != 1
    ):
        raise RuntimeError("Invalid native checkpoint schema")
    build_url(value["root_build_id"])
    if value["origin_build_id"]:
        build_url(value["origin_build_id"])
    if not re.fullmatch(
        re.escape(IMAGE) + r"@sha256:[0-9a-f]{64}", value["image"]
    ) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value["config_digest"]):
        raise RuntimeError("Invalid immutable checkpoint image")
    if (
        type(value["compressed_bytes"]) is not int
        or not 0 < value["compressed_bytes"] <= 1073741824
        or not isinstance(value["baseline"], dict)
    ):
        raise RuntimeError("Invalid checkpoint size/baseline")
    return value


def resolve_build(
    read: Callable[..., Any],
    build_id: str,
    server_tag: str,
    require_success: bool = True,
    max_builds: int = 5,
) -> tuple[dict[str, str], dict[str, Any]]:
    current = build_id
    visited: set[str] = set()
    first = None
    first_identity = None
    for depth in range(max_builds):
        if current in visited:
            raise RuntimeError("Cyclic recovery lineage")
        visited.add(current)
        build = read(build_url(current))
        if build.get("status") not in (
            ("SUCCESS",)
            if depth == 0 and require_success
            else ("SUCCESS", "FAILURE", "TIMEOUT", "CANCELLED")
        ):
            raise RuntimeError(
                "Original native build is not terminal or successful as required"
            )
        # Identity validation is independent of terminal outcome. No caller can
        # cause a failed build to masquerade as successful to the client.
        identity = build_identity(
            {**build, "status": "WORKING"}, current, server_tag, successful=False
        )
        proof = checkpoint(build)
        if proof["source"] != identity["source"] or proof[
            "origin_build_id"
        ] != build.get("substitutions", {}).get("_RECOVER_BUILD_ID", ""):
            raise RuntimeError("Recovery checkpoint source/origin mismatch")
        if first is None:
            first, first_identity = proof, identity
            if require_success:
                successful = build_identity(build, current, server_tag)
                if successful["image"] != proof["image"]:
                    raise RuntimeError(
                        "Native result image differs from durable checkpoint"
                    )
        elif any(
            proof[k] != first[k]
            for k in (
                "root_build_id",
                "source",
                "image",
                "config_digest",
                "compressed_bytes",
                "baseline",
            )
        ):
            raise RuntimeError("Recovery changed original image or baseline")
        if not proof["origin_build_id"]:
            if proof["root_build_id"] != current:
                raise RuntimeError("Recovery root identity mismatch")
            first_identity["revision"] = (
                "keepsidianserver-b-" + current.replace("-", "")[:16]
            )
            first_identity["image"] = first["image"]
            first_identity["root_build_id"] = current
            return first_identity, first
        current = proof["origin_build_id"]
    raise RuntimeError("Recovery lineage exceeds five builds")


def verify_revision(revision: dict[str, Any], identity: dict[str, str]) -> None:
    expected = RESOURCE + "/revisions/" + identity["revision"]
    containers = revision.get("containers", [])
    if (
        revision.get("name") != expected
        or revision.get("serviceAccount") != RUNTIME
        or len(containers) != 1
        or containers[0].get("image") != identity["image"]
        or revision.get("labels", {}).get("commit-sha") != identity["source"]
        or not any(
            c.get("type") == "Ready" and c.get("state") == "CONDITION_SUCCEEDED"
            for c in revision.get("conditions", [])
        )
    ):
        raise RuntimeError("Exact backend revision/image/source/runtime is not Ready")
    env = {e.get("name"): e.get("value") for e in containers[0].get("env", [])}
    if (
        env.get("OPENAI_MODEL") != "gpt-6-luna"
        or env.get("KEEPSIDIAN_REPLAY_ENABLED") != "true"
    ):
        raise RuntimeError("Backend model/replay profile mismatch")


def routes(items: list[dict[str, Any]]) -> list[tuple[str, str, int]]:
    found = []
    for item in items:
        if item.get(
            "type"
        ) != "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION" or not item.get("revision"):
            raise RuntimeError("All routes must reference explicit revisions")
        found.append(
            (
                item.get("tag", ""),
                item["revision"].rsplit("/", 1)[-1],
                int(item.get("percent", 0)),
            )
        )
    tags = [x[0] for x in found if x[0]]
    if len(tags) != len(set(tags)):
        raise RuntimeError("Duplicate aliases")
    return sorted(found)


def desired_mapping(
    service: dict[str, Any], identity: dict[str, str], client_tag: str
) -> list[dict[str, Any]]:
    target = alias(client_tag, "v")
    semantic = alias(identity["server_tag"], "sv")
    observed = routes(service.get("traffic", []))
    if (
        not service.get("etag")
        or service.get("reconciling")
        or observed != routes(service.get("trafficStatuses", []))
    ):
        raise RuntimeError("Service traffic is not converged or lacks etag")
    if [r for t, r, _ in observed if t == semantic] != [identity["revision"]]:
        raise RuntimeError(
            "Chosen server version is not mapped to the verified build revision"
        )
    existing = [r for t, r, _ in observed if t == target]
    if existing and existing != [identity["revision"]]:
        raise RuntimeError("Client alias conflict; never repoint an existing alias")
    result = deepcopy(service.get("traffic", []))
    if not existing:
        result.append(
            {
                "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
                "revision": identity["revision"],
                "tag": target,
            }
        )
    return result


def map_client(
    build_id: str,
    server_tag: str,
    client_tag: str,
    read: Callable[..., Any],
    smoke: Callable[[str], None],
    pause: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    alias(client_tag, "v")
    identity, _ = resolve_build(read, build_id, server_tag)
    revision_url = RUN + "/revisions/" + identity["revision"]
    verify_revision(read(revision_url), identity)
    verify_runtime(read, identity)
    before = read(RUN)
    desired = desired_mapping(before, identity, client_tag)
    if routes(desired) != routes(before["traffic"]):
        # Exactly one conditional submission. A timeout/409 is reconciled, never retried blindly.
        try:
            response = read(
                RUN + "?updateMask=traffic",
                {"name": RESOURCE, "etag": before["etag"], "traffic": desired},
            )
            if response.get("error"):
                raise RuntimeError("Cloud Run rejected mapping")
        except Exception:
            pass
    for _ in range(18):
        after = read(RUN)
        if after.get("template") != before.get("template"):
            raise RuntimeError("Concurrent template change; no further writes")
        current = routes(after.get("traffic", []))
        if current not in (routes(before["traffic"]), routes(desired)):
            raise RuntimeError("Concurrent routing change; preserve state and stop")
        if (
            current == routes(desired)
            and routes(after.get("trafficStatuses", [])) == current
            and not after.get("reconciling")
        ):
            break
        pause(2)
    else:
        raise RuntimeError(
            "Mapping outcome unresolved; read back on next invocation, do not resubmit now"
        )
    verify_revision(read(revision_url), identity)
    verify_runtime(read, identity)
    url = "https://" + alias(client_tag, "v") + SUFFIX
    smoke(url)
    final = read(RUN)
    if (
        final.get("template") != before.get("template")
        or routes(final.get("traffic", [])) != routes(desired)
        or routes(final.get("trafficStatuses", [])) != routes(desired)
        or final.get("reconciling")
    ):
        raise RuntimeError("Mapping drift after URL verification")
    return {
        "schema": 1,
        "client_tag": client_tag,
        "backend": url,
        **identity,
        "independent_backend_verification": True,
    }


def load_policy(path: Path) -> None:
    value = json.loads(path.read_text())
    core = value.pop("recovery_core", None)
    if core is not None and not re.fullmatch(r"[0-9a-f]{40}", core):
        raise RuntimeError("Invalid approved recovery core")
    if value != {
        "schema": 1,
        "enabled": True,
        "trigger_id": TRIGGER,
        "build_service_account": BUILD_SA,
    }:
        raise RuntimeError("Native release policy is disabled or not exactly approved")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--policy", type=Path, required=True)
    p.add_argument("--build-id", required=True)
    p.add_argument("--server-tag", required=True)
    p.add_argument("--client-tag", required=True)
    p.add_argument("--receipt", type=Path, required=True)
    a = p.parse_args()
    load_policy(a.policy)
    token = os.environ.pop("ACCESS_TOKEN")

    def read(url: str, body: dict[str, Any] | None = None) -> Any:
        return request(url, token, body)

    # Reuse the existing bounded five-GET replay/enrichment/subscribe smoke contract.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "publisher", Path(__file__).with_name("hosted-release-beta8.py")
    )
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)

    def smoke(url: str) -> None:
        publisher.BACKEND = url
        publisher.backend()

    receipt = map_client(a.build_id, a.server_tag, a.client_tag, read, smoke)
    a.receipt.write_text(json.dumps(receipt, sort_keys=True) + "\n")
