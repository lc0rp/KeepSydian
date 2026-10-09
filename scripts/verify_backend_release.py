"""Require a successful pinned backend workflow and its exact release proof."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import time
from typing import Any, Callable
from release_plan import load
from restore_release_artifact import api, restore

REPO = "lc0rp/KeepSidianServer"


def verify(
    plan: dict[str, Any],
    run_id: int,
    artifact_id: int,
    head: str,
    destination: Path,
    read: Callable[..., Any] = api,
    sleep: Callable[[int], None] = time.sleep,
) -> dict[str, Any]:
    run = read(f"repos/{REPO}/actions/runs/{run_id}")
    for _ in range(18):
        if run.get("status") == "completed":
            break
        sleep(10)
        run = read(f"repos/{REPO}/actions/runs/{run_id}")
    if run.get("status") != "completed":
        raise RuntimeError("Backend release must finish successfully before the client")
    core = REPO + "/.github/workflows/release-cloudrun-core.yml@" + plan["backend_core"]
    allowed = {
        "backend-release-receipt.json",
        "image-release-receipt.json",
        "image-lineage.json",
        "image-ref.txt",
        "release-evidence/registry-permissions.json",
        "release-evidence/local-image-size.json",
        "release-evidence/image-intent.json",
        "release-evidence/cloud-intents.jsonl",
        "release-evidence/cloud-receipts.jsonl",
        "release-evidence/command-error.json",
        "recovered/artifact-origin.json",
    }
    origin = restore(
        REPO,
        run_id,
        artifact_id,
        head,
        core,
        "keepsidian-server-evidence",
        allowed,
        {"backend-release-receipt.json"},
        destination,
        read,
    )
    jobs = read(f"repos/{REPO}/actions/runs/{run_id}/jobs?filter=latest&per_page=100")
    if jobs.get("total_count", 0) > 100:
        raise RuntimeError("Backend job evidence exceeds the bounded lookup")
    stages = {}
    for name in ("release / deploy", "release / publish-refs"):
        matches = [job for job in jobs["jobs"] if job.get("name") == name]
        if len(matches) != 1 or matches[0].get("conclusion") != "success":
            raise RuntimeError(
                "Backend deploy and refs must finish successfully before the client"
            )
        stages[name] = matches[0]
    if stages["release / deploy"].get("run_attempt") != origin["attempt"]:
        raise RuntimeError(
            "Backend artifact is not from the latest successful deployment"
        )
    receipt = json.loads((destination / "backend-release-receipt.json").read_text())
    validate_receipt(plan, receipt)
    return receipt


def validate_receipt(plan: dict[str, Any], receipt: dict[str, Any]) -> None:
    expected = {
        "source": plan["server_source"],
        "client_source": plan["client_source"],
        "client_version": plan["client_version"],
        "server_version": plan["server_version"],
        "revision": plan["revision"],
        "model": plan["model"],
        "tags": plan["tags"],
        "runtime": "keepsidian-runtime@lc0rp-labs.iam.gserviceaccount.com",
        "replay_enabled": True,
        "prior_routing_preserved": True,
        "status": "verified",
        "provider_calls": 0,
        "backend_gets": 10,
    }
    if any(receipt.get(k) != v for k, v in expected.items()) or not re.fullmatch(
        r"us-central1-docker\.pkg\.dev/lc0rp-labs/cloud-run-source-deploy/keepsidianserver@sha256:[0-9a-f]{64}",
        receipt.get("image", ""),
    ):
        raise RuntimeError(
            "Backend proof differs from the reviewed client/backend tuple"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--artifact-id", type=int, required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    verify(
        load(args.plan, "client"),
        args.run_id,
        args.artifact_id,
        args.head,
        args.destination,
    )
