"""Native Cloud Build provenance and etag-protected client alias mapping.

No IAM writes, builds, deployment, tag repointing or arbitrary endpoints here.
Client-only releases use exactly the same verifier/mapper as paired releases.
"""

from __future__ import annotations
import argparse
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
    identity = build_identity(read(build_url(build_id)), build_id, server_tag)
    revision_url = RUN + "/revisions/" + identity["revision"]
    verify_revision(read(revision_url), identity)
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
