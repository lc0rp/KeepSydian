"""Restore one immutable Actions artifact; no newest/name-only selection.

The caller supplies the reviewed run head and reusable workflow identity, never
values learned from the artifact itself. Uses the job's short-lived GitHub token.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile
from typing import Any, Callable

LIMIT = 32 * 1024 * 1024


def api(path: str, binary: bool = False) -> Any:
    result = subprocess.run(["gh", "api", path], capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(
            "Artifact API read failed; absence/auth/transport are not interchangeable"
        )
    if len(result.stdout) > LIMIT:
        raise RuntimeError("Artifact response exceeds limit")
    return result.stdout if binary else json.loads(result.stdout)


def restore(
    repo: str,
    run_id: int,
    artifact_id: int,
    head: str,
    core: str | list[str],
    prefix: str | list[str],
    allowed: set[str],
    required: set[str],
    destination: Path,
    read: Callable[..., Any] = api,
) -> dict[str, Any]:
    cores = [core] if isinstance(core, str) else core
    if (
        not re.fullmatch(r"[\w-]+/[\w.-]+", repo)
        or not re.fullmatch(r"[0-9a-f]{40}", head)
        or not cores
        or any(
            not re.fullmatch(
                re.escape(repo) + r"/\.github/workflows/[\w.-]+@[0-9a-f]{40}", item
            )
            for item in cores
        )
        or type(run_id) is not int
        or run_id <= 0
        or type(artifact_id) is not int
        or artifact_id <= 0
    ):
        raise ValueError(
            "Exact repository, run, artifact, source and core identities required"
        )
    run = read(f"repos/{repo}/actions/runs/{run_id}")
    artifact = read(f"repos/{repo}/actions/artifacts/{artifact_id}")
    prefixes = [prefix] if isinstance(prefix, str) else prefix
    attempt = next(
        (
            match
            for item in prefixes
            if (
                match := re.fullmatch(
                    re.escape(item) + f"-{run_id}-([1-9][0-9]*)",
                    artifact.get("name", ""),
                )
            )
        ),
        None,
    )
    if (
        run.get("id") != run_id
        or run.get("head_sha") != head
        or run.get("head_branch") != "main"
        or run.get("event") != "workflow_dispatch"
        or run.get("status") != "completed"
        or run.get("repository", {}).get("full_name") != repo
        or not any(
            w.get("path") in cores and w.get("sha") == w["path"].rsplit("@", 1)[1]
            for w in run.get("referenced_workflows", [])
        )
        or artifact.get("id") != artifact_id
        or artifact.get("expired") is not False
        or artifact.get("workflow_run", {}).get("id") != run_id
        or artifact.get("workflow_run", {}).get("head_sha") != head
        or not attempt
        or int(attempt[1]) > run.get("run_attempt", 0)
        or not 0 < artifact.get("size_in_bytes", 0) <= LIMIT
    ):
        raise RuntimeError("Artifact provenance mismatch or expired evidence")
    digest = artifact.get("digest", "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError("Canonical archive digest is required")
    payload = read(f"repos/{repo}/actions/artifacts/{artifact_id}/zip", binary=True)
    if (
        not isinstance(payload, bytes)
        or len(payload) > LIMIT
        or "sha256:" + hashlib.sha256(payload).hexdigest() != digest
    ):
        raise RuntimeError("Archive digest/size mismatch")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        members = archive.infolist()
        names = [item.filename for item in members]
        if (
            len(names) != len(set(names))
            or not required.issubset(names)
            or set(names) - allowed
            or sum(x.file_size for x in members) > LIMIT
            or any(
                x.is_dir()
                or x.file_size > LIMIT
                or x.flag_bits & 1
                or (x.external_attr >> 16) & 0o170000 == 0o120000
                for x in members
            )
            or any(
                Path(name).is_absolute() or ".." in Path(name).parts for name in names
            )
        ):
            raise RuntimeError(
                "Unexpected, duplicate, unsafe or oversized archive members"
            )
        contents = {name: archive.read(name) for name in names}
    # Validate everything before writing anything; do not overwrite checkout code.
    for name in contents:
        path = destination / name
        if path.exists() or path.is_symlink():
            raise RuntimeError("Recovery destination must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    for name, data in contents.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    matched_core = next(
        w["path"] for w in run["referenced_workflows"] if w["path"] in cores
    )
    proof = {
        "repository": repo,
        "run_id": run_id,
        "artifact_id": artifact_id,
        "head_sha": head,
        "core": matched_core,
        "attempt": int(attempt[1]),
        "archive_digest": digest,
        "files": {
            name: "sha256:" + hashlib.sha256(data).hexdigest()
            for name, data in contents.items()
        },
    }
    (destination / "artifact-origin.json").write_text(
        json.dumps(proof, indent=2) + "\n"
    )
    return proof


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repo", "head", "destination"):
        parser.add_argument("--" + name, required=True)
    for name in ("run-id", "artifact-id"):
        parser.add_argument("--" + name, type=int, required=True)
    parser.add_argument("--allowed", action="append", required=True)
    parser.add_argument("--required", action="append", required=True)
    parser.add_argument("--core")
    parser.add_argument("--prefix")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--side", choices=("server", "client"))
    args = parser.parse_args()
    if args.plan:
        if not args.side or args.core or args.prefix:
            parser.error("Use --plan and --side without --core/--prefix")
        from release_plan import load

        plan = load(args.plan, args.side)
        expected_repo = (
            "lc0rp/KeepSidianServer" if args.side == "server" else "lc0rp/KeepSydian"
        )
        if args.repo != expected_repo:
            parser.error("Plan repository mismatch")
        workflow = (
            "release-cloudrun-core.yml"
            if args.side == "server"
            else "release-client-core.yml"
        )
        args.core = [
            args.repo + "/.github/workflows/" + workflow + "@" + sha
            for sha in plan["recovery_cores"]
        ]
        args.prefix = plan["recovery_prefixes"]
    elif not args.core or not args.prefix:
        parser.error("Exact --core and --prefix required without a plan")
    restore(
        args.repo,
        args.run_id,
        args.artifact_id,
        args.head,
        args.core,
        args.prefix,
        set(args.allowed),
        set(args.required),
        Path(args.destination),
    )


if __name__ == "__main__":
    main()
