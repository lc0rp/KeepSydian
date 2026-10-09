"""Resolve an externally created client tag; no tag creation or backend builds."""

from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
from typing import Any, Callable
from native_cloud_release import alias, build_url, load_policy, SUFFIX
from restore_release_artifact import api

REPO = "lc0rp/KeepSydian"


def select(
    client_tag: str, server_tag: str, build_id: str, read: Callable[..., Any] = api
) -> dict[str, str]:
    url = "https://" + alias(client_tag, "v") + SUFFIX
    alias(server_tag, "sv")
    build_url(build_id)
    obj = read(f"repos/{REPO}/git/ref/tags/{client_tag}")["object"]
    # Support annotated tags without treating their tag-object SHA as application code.
    for _ in range(5):
        if obj.get("type") == "commit":
            break
        if obj.get("type") != "tag" or not re.fullmatch(
            r"[0-9a-f]{40}", obj.get("sha", "")
        ):
            raise ValueError("Invalid external client tag")
        obj = read(f"repos/{REPO}/git/tags/" + obj["sha"])["object"]
    if obj.get("type") != "commit" or not re.fullmatch(
        r"[0-9a-f]{40}", obj.get("sha", "")
    ):
        raise ValueError("External tag must resolve to one commit")
    return {
        "client_tag": client_tag,
        "client_version": client_tag[1:],
        "client_source": obj["sha"],
        "server_tag": server_tag,
        "build_id": build_id,
        "backend": url,
    }


def load(path: Path) -> dict[str, str]:
    value = json.loads(path.read_text())
    if set(value) != {
        "client_tag",
        "client_version",
        "client_source",
        "server_tag",
        "build_id",
        "backend",
    }:
        raise ValueError("Invalid native release selection")
    alias(value["client_tag"], "v")
    alias(value["server_tag"], "sv")
    build_url(value["build_id"])
    if (
        value["client_version"] != value["client_tag"][1:]
        or value["backend"] != "https://" + alias(value["client_tag"], "v") + SUFFIX
        or not re.fullmatch(r"[0-9a-f]{40}", value["client_source"])
    ):
        raise ValueError("Native selection mismatch")
    return value


def mapping_receipt(plan: dict[str, str], path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if (
        any(
            value.get(k) != plan[k]
            for k in ("client_tag", "server_tag", "build_id", "backend")
        )
        or value.get("independent_backend_verification") is not True
    ):
        raise ValueError("Mapping receipt belongs to another selection")
    return value


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--policy", type=Path, required=True)
    for key in ("client-tag", "server-tag", "build-id"):
        p.add_argument("--" + key, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    load_policy(a.policy)
    result = select(a.client_tag, a.server_tag, a.build_id)
    a.output.write_text(json.dumps(result) + "\n")
    for k in ("client_source", "backend"):
        print(k + "=" + result[k])
