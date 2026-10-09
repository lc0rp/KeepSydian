"""Detect historical workflow-tree changes before expensive release work.

GITHUB_TOKEN has contents:write, not workflows:write. This read-only guard is a
conservative compatibility check, not proof of token rights or a historical403.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from typing import Any, Callable


def api(path: str) -> Any:
    result = subprocess.run(["gh", "api", path], capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Tag-target read failed; stop before build")
    return json.loads(result.stdout)


def verify(repo: str, source: str, head: str, read: Callable[[str], Any] = api) -> None:
    if repo not in ("lc0rp/KeepSidianServer", "lc0rp/KeepSydian") or any(
        not re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (source, head)
    ):
        raise ValueError("Exact repository and reviewed source/head required")

    def workflow_tree(sha: str) -> str:
        tree = read(f"repos/{repo}/git/trees/{sha}?recursive=1")
        if tree.get("truncated") is not False:
            raise RuntimeError("Incomplete source tree")
        matches = [
            x["sha"]
            for x in tree["tree"]
            if x.get("path") == ".github/workflows" and x.get("type") == "tree"
        ]
        if len(matches) != 1:
            raise RuntimeError("Expected one workflow tree")
        return matches[0]

    if workflow_tree(source) != workflow_tree(head):
        raise RuntimeError(
            "Tag target has a different workflow tree from dispatcher head; prepare and review a source after workflow changes land. Do not widen token rights automatically."
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for key in ("repo", "source", "head"):
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()
    verify(args.repo, args.source, args.head)
