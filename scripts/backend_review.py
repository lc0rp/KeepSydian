"""Opaque handoff from an authorized reviewer; NOT a cryptographic attestation.

The private canonical evidence remains with the reviewer. The public client
trusts Luke's authenticated dispatch assertion, not an independently verified
private-repository read. A digest anchors evidence; it does not authenticate it.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, Callable

from release_plan import load

AUTHORITY = "authorized-reviewer"
REVIEWER_ID = "2609441"
REVIEWER_LOGIN = "lc0rp"
MAX_AGE_SECONDS = 6 * 60 * 60
MAX_BYTES = 1024
TUPLE_KEYS = (
    "server_source",
    "client_source",
    "server_version",
    "client_version",
    "revision",
    "image_tag",
    "backend",
    "model",
    "backend_core",
)


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def tuple_digest(plan: dict[str, Any]) -> str:
    return hashlib.sha256(canonical({key: plan[key] for key in TUPLE_KEYS})).hexdigest()


def validate(
    raw: str,
    plan: dict[str, Any],
    actor_id: str,
    triggering_actor: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    if actor_id != REVIEWER_ID or triggering_actor != REVIEWER_LOGIN:
        raise ValueError("Only the authorized reviewer may assert backend review")
    if not isinstance(raw, str) or len(raw.encode()) > MAX_BYTES:
        raise ValueError("Backend review exceeds the fixed byte limit")

    def unique(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate backend review field")
            result[key] = value
        return result

    review = json.loads(raw, object_pairs_hook=unique)
    keys = {
        "schema",
        "authority",
        "reviewer_id",
        "reviewed_at",
        "tuple_sha256",
        "evidence_sha256",
    }
    if not isinstance(review, dict) or set(review) != keys:
        raise ValueError("Unknown backend review schema or fields")
    if (
        type(review["schema"]) is not int
        or review["schema"] != 1
        or review["authority"] != AUTHORITY
        or review["reviewer_id"] != REVIEWER_ID
        or any(
            not isinstance(review[key], str)
            or not re.fullmatch(r"[0-9a-f]{64}", review[key])
            for key in ("tuple_sha256", "evidence_sha256")
        )
        or review["tuple_sha256"] != tuple_digest(plan)
    ):
        raise ValueError("Backend review differs from the reviewed release tuple")
    stamp = review["reviewed_at"]
    if not isinstance(stamp, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", stamp
    ):
        raise ValueError("Backend review requires a UTC timestamp")
    age = (
        (now or datetime.now(timezone.utc))
        - datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    ).total_seconds()
    if age < -60 or age > MAX_AGE_SECONDS:
        raise ValueError("Backend review is future-dated or expired; review again")
    return {**review, "independent_backend_verification": False}


def from_environment(plan: dict[str, Any]) -> dict[str, Any]:
    return validate(
        os.environ.get("KEEPSIDIAN_BACKEND_REVIEW", ""),
        plan,
        os.environ.get("GITHUB_ACTOR_ID", ""),
        os.environ.get("GITHUB_TRIGGERING_ACTOR", ""),
    )


def prepare(
    plan: dict[str, Any],
    run_id: int,
    artifact_id: int,
    head: str,
    destination: Path,
    read: Callable[..., Any],
    verify: Callable[..., Any],
    now: datetime | None = None,
) -> str:
    """Run only in the authorized reviewer's private workspace, with existing auth."""
    destination = destination.resolve()
    if destination.is_relative_to(Path(__file__).resolve().parent.parent):
        raise ValueError(
            "Private evidence must stay outside the public client checkout"
        )
    if destination.exists():
        raise ValueError("A fresh private evidence directory is required")
    user = read("user")
    if user.get("id") != int(REVIEWER_ID) or user.get("login") != REVIEWER_LOGIN:
        raise ValueError(
            "Existing GitHub authentication is not the authorized reviewer"
        )
    # The reviewer chooses an existing private parent directory, never public storage.
    destination.mkdir(mode=0o700)
    # No output assertion is generated on verification failure.
    verify(plan, run_id, artifact_id, head, destination, read)
    evidence = json.loads((destination / "backend-verification.json").read_text())
    review = {
        "schema": 1,
        "authority": AUTHORITY,
        "reviewer_id": REVIEWER_ID,
        "reviewed_at": (now or datetime.now(timezone.utc)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ),
        "tuple_sha256": tuple_digest(plan),
        "evidence_sha256": hashlib.sha256(canonical(evidence)).hexdigest(),
    }
    raw = canonical(review).decode()
    validate(raw, plan, REVIEWER_ID, REVIEWER_LOGIN, now)
    (destination / "review-handoff.json").write_text(raw + "\n")
    return raw


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "check"))
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--artifact-id", type=int)
    parser.add_argument("--head")
    parser.add_argument("--private-destination", type=Path)
    args = parser.parse_args()
    plan = load(args.plan, "client")
    if args.mode == "prepare":
        if not all(
            (args.run_id, args.artifact_id, args.head, args.private_destination)
        ):
            parser.error(
                "prepare requires exact run/artifact/head and private destination"
            )
        # These private-repository dependencies are never imported by check.
        from restore_release_artifact import api
        from verify_backend_release import verify

        print(
            prepare(
                plan,
                args.run_id,
                args.artifact_id,
                args.head,
                args.private_destination,
                api,
                verify,
            )
        )
    else:
        from_environment(plan)
        print(
            "Authorized-reviewer assertion accepted; private backend was not independently queried"
        )
