"""Validated release data for an immutable reusable release engine.

Plan data is checked out from the dispatcher commit on main. It must never
supply executable code, credentials, permission changes, or budget increases.
"""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
import re
from typing import Any

SHA = r"[0-9a-f]{40}"
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?"
SUFFIX = "---keepsidianserver-i55qr5tvea-uc.a.run.app"


def load(path: Path, side: str) -> dict[str, Any]:
    if path.stat().st_size > 256 * 1024:
        raise ValueError("Release plan is too large")
    plan = json.loads(path.read_text())
    common = {
        "schema",
        "client_source",
        "server_source",
        "client_version",
        "server_version",
        "revision",
        "image_tag",
        "model",
        "allow_new_build",
        "recovery_cores",
        "recovery_prefixes",
    }
    expected = common | ({"baseline"} if side == "server" else {"backend_core"})
    if (
        not isinstance(plan, dict)
        or set(plan) != expected
        or type(plan.get("schema")) is not int
        or plan.get("schema") != 1
    ):
        raise ValueError("Unknown release plan schema or fields")
    for key in ("client_source", "server_source"):
        if not isinstance(plan[key], str) or not re.fullmatch(SHA, plan[key]):
            raise ValueError("Full immutable source SHA required")
    for key in ("client_version", "server_version"):
        if not isinstance(plan[key], str) or not re.fullmatch(VERSION, plan[key]):
            raise ValueError("Supported release version required")
    tags = [
        "sv" + plan["server_version"].replace(".", "-"),
        "v" + plan["client_version"].replace(".", "-"),
    ]
    if any(len(tag) > 63 for tag in tags):
        raise ValueError("Version exceeds Cloud Run tag limit")
    if (
        not re.fullmatch(
            r"keepsidianserver-[a-z0-9-]+-" + plan["server_source"][:7],
            plan["revision"],
        )
        or len(plan["revision"]) > 63
        or not re.fullmatch(
            r"[a-z0-9-]+-" + plan["server_source"][:7], plan["image_tag"]
        )
        or plan["model"] != "gpt-6-luna"
        or type(plan["allow_new_build"]) is not bool
        or not isinstance(plan["recovery_cores"], list)
        or not plan["recovery_cores"]
        or any(
            not isinstance(x, str) or not re.fullmatch(SHA, x)
            for x in plan["recovery_cores"]
        )
    ):
        raise ValueError("Unreviewed revision/model/build/recovery policy")
    if (
        not isinstance(plan["recovery_prefixes"], list)
        or not plan["recovery_prefixes"]
        or any(
            not isinstance(x, str) or not re.fullmatch(r"[a-z0-9-]+", x)
            for x in plan["recovery_prefixes"]
        )
    ):
        raise ValueError("Safe artifact name prefix required")
    if side == "server":
        if not isinstance(plan["baseline"], dict) or set(plan["baseline"]) != {
            "captured_at",
            "source",
            "template",
            "annotations",
            "labels",
            "traffic",
        }:
            raise ValueError("Exact live baseline required")
        fixed = json.loads(
            Path(__file__).with_name("release-beta8-baseline.json").read_text()
        )

        def runtime_profile(baseline: dict[str, Any]) -> dict[str, Any]:
            profile = deepcopy(
                {key: baseline[key] for key in ("template", "annotations", "labels")}
            )
            profile["labels"].pop("commit-sha", None)
            profile["template"]["metadata"].pop("name", None)
            profile["template"]["metadata"]["labels"].pop("commit-sha", None)
            profile["template"]["spec"]["containers"][0].pop("image", None)
            return profile

        if runtime_profile(plan["baseline"]) != runtime_profile(fixed):
            raise ValueError(
                "Runtime, secret, network and resource changes require engine review"
            )
    elif not isinstance(plan["backend_core"], str) or not re.fullmatch(
        SHA, plan["backend_core"]
    ):
        raise ValueError("Reviewed backend reusable core required")
    plan["tags"] = tags
    plan["backend"] = "https://" + tags[1] + SUFFIX
    return plan


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("side", choices=("client", "server"))
    parser.add_argument("path", type=Path)
    parser.add_argument("--new-build", action="store_true")
    args = parser.parse_args()
    plan = load(args.path, args.side)
    if args.new_build and not plan["allow_new_build"]:
        parser.error(
            "This reviewed plan permits recovery only; prepare and review the next release plan"
        )
    for key in ("client_source", "server_source", "backend", "revision", "image_tag"):
        print(f"{key}={plan[key]}")
