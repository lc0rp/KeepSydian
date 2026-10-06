"""Reconcile one reviewed client prerelease using the repository job token.

The workflow supplies a literal reviewed source SHA, never a dispatch input.
Backend verification and asset checks run even when the release is published.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, Callable
from urllib.request import urlopen

REPO = "lc0rp/KeepSydian"
VERSION = "2.1.0-beta.6b"
TAG = "v" + VERSION
BACKEND = "https://v2-1-0-beta-6b---keepsidianserver-i55qr5tvea-uc.a.run.app"
ASSETS = ("main.js", "manifest.json", "styles.css")


def command(args: list[str]) -> Any:
    result = subprocess.run(args, capture_output=True, timeout=60, check=False)
    if result.returncode:
        if args[:2] == ["gh", "api"] and b"HTTP 404" in result.stderr:
            return None
        raise RuntimeError(f"Release command failed: {args[0]} (exit {result.returncode})")
    if args[:2] == ["gh", "api"]:
        return json.loads(result.stdout) if result.stdout.strip() else None
    return result.stdout


def backend(get: Callable[[str], bytes] | None = None) -> None:
    def fetch(url: str) -> bytes:
        with urlopen(url, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError("Backend check did not return HTTP 200")
            return response.read(65536)
    get = get or fetch
    if json.loads(get(BACKEND + "/keep/sync/capabilities")) != {"replay_version": 0, "replay_epoch": None}:
        raise RuntimeError("Backend must advertise the reviewed replay-off profile")
    get(BACKEND + "/subscribe")


def validate(root: Path) -> dict[str, str]:
    manifest = json.loads((root / "manifest.json").read_text())
    package = json.loads((root / "package.json").read_text())
    if manifest.get("version") != VERSION or package.get("version") != VERSION:
        raise RuntimeError("Reviewed package/manifest version mismatch")
    if BACKEND not in (root / "main.js").read_text():
        raise RuntimeError("Built bundle does not contain the beta.6b backend URL")
    hashes = {}
    for name in ASSETS:
        payload = (root / name).read_bytes()
        if not payload:
            raise RuntimeError(f"Empty release asset: {name}")
        hashes[name] = "sha256:" + hashlib.sha256(payload).hexdigest()
    return hashes


def asset_digest(asset: dict[str, Any], run: Callable[[list[str]], Any]) -> str:
    digest = asset.get("digest")
    if digest and re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        return digest
    # Older release metadata can lack a digest. Download only this release's
    # artifact bytes through the supported CLI and hash them without printing.
    result = subprocess.run(
        ["gh", "api", f"repos/{REPO}/releases/assets/{int(asset['id'])}",
         "--header", "Accept: application/octet-stream"],
        capture_output=True, timeout=60, check=False,
    )
    if result.returncode:
        raise RuntimeError("Cannot verify existing release asset bytes")
    return "sha256:" + hashlib.sha256(result.stdout).hexdigest()


def reconcile(source: str, root: Path, run: Callable[[list[str]], Any] = command,
              get: Callable[[str], bytes] | None = None,
              digest: Callable[[dict[str, Any], Callable], str] = asset_digest) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ValueError("A full reviewed source SHA is required")
    backend(get)
    local = validate(root)
    actual_source = run(["git", "-C", str(root), "rev-parse", "HEAD"])
    if actual_source.decode().strip() != source:
        raise RuntimeError("Built checkout differs from the reviewed client source")
    prefix = f"repos/{REPO}"
    ref_path = f"{prefix}/git/ref/tags/{TAG}"
    ref = run(["gh", "api", ref_path])
    if ref is not None:
        obj = ref["object"]
        if obj.get("type") != "commit" or obj.get("sha") != source:
            raise RuntimeError("Client tag already points at an unreviewed source")
    else:
        run(["gh", "api", "--method", "POST", f"{prefix}/git/refs",
             "-f", f"ref=refs/tags/{TAG}", "-f", f"sha={source}"])
        ref = run(["gh", "api", ref_path])
        if not ref or ref["object"].get("sha") != source:
            raise RuntimeError("Client source tag readback mismatch")
    # The release-by-tag endpoint only returns published releases. Authenticated
    # listings also include drafts for this repository's contents-write token.
    def find_release() -> dict[str, Any] | None:
        pages = run(["gh", "api", f"{prefix}/releases?per_page=100", "--paginate", "--slurp"])
        if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
            raise RuntimeError("Cannot discover draft/published release metadata")
        matches = [item for page in pages for item in page if item.get("tag_name") == TAG]
        if len(matches) > 1:
            raise RuntimeError("Multiple releases use the beta.6b tag; stop for review")
        return matches[0] if matches else None
    release = find_release()
    if release is None:
        notes = f"KeepSydian {VERSION}\n\nClient source: {source}\nBackend: {BACKEND}/\nUses verified server beta.6; replay remains disabled.\n"
        with tempfile.TemporaryDirectory() as temp:
            notes_path = Path(temp) / "notes.md"
            notes_path.write_text(notes)
            run(["gh", "release", "create", TAG, "--repo", REPO,
                 "--verify-tag", "--draft", "--prerelease", "--latest=false",
                 "--title", TAG, "--notes-file", str(notes_path)])
        release = find_release()
    if not release or release.get("tag_name") != TAG or not release.get("prerelease"):
        raise RuntimeError("Expected beta.6b prerelease metadata")
    assets_path = f"{prefix}/releases/{int(release['id'])}/assets?per_page=100"
    def inspect() -> dict[str, dict[str, Any]]:
        pages = run(["gh", "api", assets_path, "--paginate", "--slurp"])
        assets = [asset for page in pages for asset in page]
        indexed = {asset["name"]: asset for asset in assets}
        if len(indexed) != len(assets) or set(indexed) - set(ASSETS):
            raise RuntimeError("Unexpected or duplicate release assets")
        for name, asset in indexed.items():
            if asset.get("state") != "uploaded" or digest(asset, run) != local[name]:
                raise RuntimeError(f"Existing release asset differs: {name}; no overwrite")
        return indexed
    observed = inspect()
    missing = [name for name in ASSETS if name not in observed]
    if missing and not release.get("draft"):
        raise RuntimeError("Published prerelease has missing assets; stop for review")
    for name in missing:
        run(["gh", "release", "upload", TAG, str(root / name), "--repo", REPO])
    if set(inspect()) != set(ASSETS):
        raise RuntimeError("Release asset readback incomplete")
    # No published-release early return: backend, source and all hashes were
    # verified first. Draft recovery uploads only missing files, never clobbers.
    if release.get("draft"):
        run(["gh", "release", "edit", TAG, "--repo", REPO,
             "--draft=false", "--prerelease", "--latest=false", "--verify-tag"])
    final = find_release()
    if not final or final.get("draft") or not final.get("prerelease"):
        raise RuntimeError("Prerelease publication readback failed")
    receipt = {"source": source, "tag": TAG, "backend": BACKEND,
               "release_id": final["id"], "url": final["html_url"], "assets": local}
    (root / "release-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("backend", "publish"))
    parser.add_argument("--source")
    args = parser.parse_args()
    if args.mode == "backend":
        backend()
        print("Verified beta.6b backend URL and replay-off profile.")
    else:
        if not args.source:
            parser.error("publish requires --source")
        print(json.dumps(reconcile(args.source, Path.cwd()), indent=2))


if __name__ == "__main__":
    main()
