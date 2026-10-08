"""Publish only the reviewed beta.7 assets after the server release is verified.

Run with the publishing job's GITHUB_TOKEN, never a personal token. The server
workflow/operator must first verify the deployed image and live Luna setting;
the public capabilities check below proves routing/replay stability, not model.
Creation is never retried after an ambiguous POST. Retain release-intent.json
and release-receipt.json as workflow artifacts, including on failure.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Callable
from urllib.request import HTTPRedirectHandler, build_opener

REPO = "lc0rp/KeepSydian"
VERSION = "2.1.0-beta.7"
TAG = "v" + VERSION
BACKEND = "https://v2-1-0-beta-7---keepsidianserver-i55qr5tvea-uc.a.run.app"
ASSETS = ("main.js", "manifest.json", "styles.css")
MAX_BYTES = 20 * 1024 * 1024
READ_ATTEMPTS = 3


def command(args: list[str]) -> Any:
    result = subprocess.run(args, capture_output=True, timeout=60, check=False)
    if result.returncode:
        # A failed write is ambiguous, including HTTP 404. Never turn it into
        # permission to repeat creation. Only a read's 404 means absent.
        if args[:2] == ["gh", "api"] and "--method" not in args and b"HTTP 404" in result.stderr:
            return None
        raise RuntimeError(f"Release command failed: {args[0]} (exit {result.returncode})")
    if args[:2] == ["gh", "api"]:
        if "Accept: application/octet-stream" in args:
            return result.stdout
        return json.loads(result.stdout) if result.stdout.strip() else None
    return result.stdout


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Backend check must not redirect")


def backend(get: Callable[[str], bytes] | None = None) -> str:
    def fetch(url: str) -> bytes:
        with build_opener(NoRedirect()).open(url, timeout=45) as response:
            if response.status != 200:
                raise RuntimeError("Backend check did not return HTTP 200")
            payload = response.read(65537)
            if len(payload) > 65536:
                raise RuntimeError("Backend check response is too large")
            return payload
    get = get or fetch

    def capabilities() -> dict[str, Any]:
        value = json.loads(get(BACKEND + "/keep/sync/capabilities"))
        if (not isinstance(value, dict) or set(value) != {"replay_version", "replay_epoch"}
                or type(value["replay_version"]) is not int or value["replay_version"] != 1
                or not isinstance(value["replay_epoch"], str)
                or not re.fullmatch(r"[0-9a-f]{32}", value["replay_epoch"])):
            raise RuntimeError("Backend must advertise replay version 1 and a valid epoch")
        return value
    before = capabilities()
    get(BACKEND + "/subscribe")
    if capabilities() != before:
        raise RuntimeError("Backend replay epoch changed during routing check")
    return before["replay_epoch"]


def validate(root: Path) -> dict[str, str]:
    manifest, package, lock, versions = [json.loads((root / name).read_text()) for name in
                                       ("manifest.json", "package.json", "package-lock.json", "versions.json")]
    if any(value != VERSION for value in (manifest.get("version"), package.get("version"),
                                           lock.get("version"), lock.get("packages", {}).get("", {}).get("version"))):
        raise RuntimeError("Reviewed package/manifest/lock version mismatch")
    if manifest.get("minAppVersion") != "1.6.5" or versions.get(VERSION) != "1.6.5":
        raise RuntimeError("Reviewed minimum app version mismatch")
    bundle = (root / "main.js").read_text()
    urls = set(re.findall(r"https://(?:[\w-]+---)?keepsidianserver-[\w-]+\.a\.run\.app", bundle))
    if urls != {BACKEND} or not re.search(r'var rawServerUrl = "' + re.escape(BACKEND) + r'";', bundle):
        raise RuntimeError("Built bundle must use only the beta.7 backend URL")
    if not re.search(r"// src/services/recovery-uat\.ts\n[^\n]*\nvar enabled = false;", bundle):
        raise RuntimeError("Built recovery UAT must be disabled")
    hashes = {}
    total = 0
    for name in ASSETS:
        payload = (root / name).read_bytes()
        total += len(payload)
        if not payload or len(payload) > MAX_BYTES:
            raise RuntimeError(f"Empty or oversized release asset: {name}")
        hashes[name] = "sha256:" + hashlib.sha256(payload).hexdigest()
    if total > MAX_BYTES:
        raise RuntimeError("Combined release assets exceed 20 MiB")
    return hashes


def asset_digest(asset: dict[str, Any], run: Callable[[list[str]], Any]) -> str:
    digest = asset.get("digest")
    if isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        return digest
    payload = run(["gh", "api", f"repos/{REPO}/releases/assets/{int(asset['id'])}",
                   "--header", "Accept: application/octet-stream"])
    if not isinstance(payload, bytes) or len(payload) > MAX_BYTES:
        raise RuntimeError("Cannot verify existing release asset bytes")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def reconcile(source: str, root: Path, run: Callable[[list[str]], Any] = command,
              get: Callable[[str], bytes] | None = None,
              digest: Callable[[dict[str, Any], Callable], str] = asset_digest) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ValueError("A full reviewed source SHA is required")
    local = validate(root)
    epoch = backend(get)
    actual = run(["git", "-C", str(root), "rev-parse", "HEAD"])
    if actual.decode().strip() != source:
        raise RuntimeError("Built checkout differs from the reviewed client source")
    prefix = f"repos/{REPO}"
    ref_path = f"{prefix}/git/ref/tags/{TAG}"
    intent_path = root / "release-intent.json"

    def save(value: dict[str, Any]) -> None:
        intent_path.write_text(json.dumps(value, indent=2) + "\n")

    def check_ref(required: bool = True) -> Any:
        ref = run(["gh", "api", ref_path])
        if ref is None and not required:
            return None
        if not isinstance(ref, dict) or ref.get("object", {}).get("type") != "commit" or ref["object"].get("sha") != source:
            raise RuntimeError("Client tag points at an unreviewed source or is absent")
        return ref

    def find_release() -> Any:
        pages = run(["gh", "api", f"{prefix}/releases?per_page=100", "--paginate", "--slurp"])
        if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
            raise RuntimeError("Cannot discover draft/published release metadata")
        matches = [item for page in pages for item in page if item.get("tag_name") == TAG]
        if len(matches) > 1:
            raise RuntimeError("Multiple releases use the beta.7 tag; stop for review")
        return matches[0] if matches else None

    def check_release(value: Any, release_id: int | None = None) -> dict[str, Any]:
        if (not isinstance(value, dict) or type(value.get("id")) is not int
                or value.get("tag_name") != TAG or value.get("prerelease") is not True
                or type(value.get("draft")) is not bool
                or (release_id is not None and value["id"] != release_id)):
            raise RuntimeError("Expected beta.7 prerelease metadata")
        return value

    def canonical(release_id: int) -> dict[str, Any]:
        for _ in range(READ_ATTEMPTS):
            value = run(["gh", "api", f"{prefix}/releases/{release_id}"])
            if value is not None:
                return check_release(value, release_id)
        raise RuntimeError("Canonical release readback unavailable; retain intent, do not recreate")

    # Discover and validate before the first remote mutation.
    release = find_release()
    ref = check_ref(required=False)
    if release is not None:
        release = check_release(release)
        if ref is None:
            raise RuntimeError("Existing release has no reviewed source tag")
        release = canonical(release["id"])
    else:
        if intent_path.exists():
            intent = json.loads(intent_path.read_text())
            if intent.get("source") != source or intent.get("tag") != TAG:
                raise RuntimeError("Release intent belongs to a different source")
            if type(intent.get("release_id")) is int:
                release = canonical(intent["release_id"])
                check_ref()
            else:
                raise RuntimeError("Prior creation is ambiguous; inspect before creating again")
        else:
            if ref is not None:
                # A prior job may have lost its POST response and its local
                # intent artifact. A lagging list must never authorize a second
                # creation in a fresh runner. Operator reconciliation is needed.
                raise RuntimeError("Existing source tag has no visible release; inspect before creating again")
            if ref is None:
                run(["gh", "api", "--method", "POST", f"{prefix}/git/refs",
                     "-f", f"ref=refs/tags/{TAG}", "-f", f"sha={source}"])
                check_ref()
            notes = (f"KeepSydian {VERSION}\n\nClient source: {source}\nBackend: {BACKEND}/\n"
                     "Combined title/tag generation, sixteen-note pages and sync conflict fixes.\n"
                     "The preceding server release verifies the immutable image and live GPT-6 Luna setting.\n"
                     "Replay is process-local: restart/multiple workers lose continuations; inactivity limit "
                     "15 minutes, absolute limit 2 hours. Review generated long-note titles/tags; revised "
                     "final-decision prompts have not been evaluated with additional paid calls.\n")
            intent = {"source": source, "tag": TAG, "status": "creation-started"}
            save(intent)
            created = run(["gh", "api", "--method", "POST", f"{prefix}/releases",
                           "-f", f"tag_name={TAG}", "-f", f"target_commitish={source}",
                           "-f", f"name={TAG}", "-f", f"body={notes}",
                           "-F", "draft=true", "-F", "prerelease=true", "-f", "make_latest=false"])
            created = check_release(created)
            if not created["draft"]:
                raise RuntimeError("New release was not created as a draft")
            save({**intent, "status": "created", "release_id": created["id"]})
            release = canonical(created["id"])
    release_id = release["id"]
    save({"source": source, "tag": TAG, "status": "reconciling", "release_id": release_id})
    assets_path = f"{prefix}/releases/{release_id}/assets?per_page=100"

    def inspect() -> dict[str, dict[str, Any]]:
        pages = run(["gh", "api", assets_path, "--paginate", "--slurp"])
        if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
            raise RuntimeError("Cannot read release assets")
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
    if missing and not release["draft"]:
        raise RuntimeError("Published prerelease has missing assets; stop for review")
    for name in missing:
        check_ref()
        if not canonical(release_id)["draft"]:
            raise RuntimeError("Release was published during recovery; stop for review")
        run(["gh", "api", "--method", "POST",
             f"https://uploads.github.com/repos/{REPO}/releases/{release_id}/assets?name={name}",
             "--header", "Content-Type: application/octet-stream", "--input", str(root / name)])
    if set(inspect()) != set(ASSETS):
        raise RuntimeError("Release asset readback incomplete")
    check_ref()
    release = canonical(release_id)
    if release["draft"]:
        run(["gh", "api", "--method", "PATCH", f"{prefix}/releases/{release_id}",
             "-F", "draft=false", "-F", "prerelease=true", "-f", "make_latest=false"])
    final = canonical(release_id)
    if final["draft"]:
        raise RuntimeError("Prerelease publication readback failed")
    check_ref()
    if set(inspect()) != set(ASSETS):
        raise RuntimeError("Published asset readback incomplete")
    receipt = {"source": source, "tag": TAG, "backend": BACKEND, "replay_epoch": epoch,
               "release_id": release_id, "url": final["html_url"], "assets": local}
    (root / "release-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("backend", "publish"))
    parser.add_argument("--source")
    args = parser.parse_args()
    if args.mode == "backend":
        print(f"Verified beta.7 routing and stable replay epoch: {backend()}")
    else:
        if not args.source:
            parser.error("publish requires --source")
        print(json.dumps(reconcile(args.source, Path.cwd()), indent=2))


if __name__ == "__main__":
    main()
