"""Offline release recovery checks: no provider calls, tokens or repository writes."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("hosted-release.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SOURCE = "1" * 40


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("manifest.json", "package.json"):
            (self.root / name).write_text(json.dumps({"version": m.VERSION}))
        (self.root / "main.js").write_text("const backend=" + json.dumps(m.BACKEND))
        (self.root / "styles.css").write_text(".plugin { color: inherit; }")
        self.hashes = m.validate(self.root)
        self.calls = []
        self.gets = []
        self.ref = None
        self.release = None
        self.assets = {}
        self.duplicate_release = None

    def get(self, url):
        self.gets.append(url)
        return b'{"replay_version":0,"replay_epoch":null}' if url.endswith("/capabilities") else b"OK"

    def complete_release(self, draft=False):
        self.ref = {"object": {"type": "commit", "sha": SOURCE}}
        self.release = {"id": 42, "tag_name": m.TAG, "draft": draft, "prerelease": True,
                        "html_url": f"https://github.com/{m.REPO}/releases/tag/{m.TAG}"}
        self.assets = {name: {"id": i, "name": name, "state": "uploaded", "digest": self.hashes[name]}
                       for i, name in enumerate(m.ASSETS, start=100)}

    def run_cli(self, args):
        self.calls.append(args)
        if args[0] == "git":
            return (SOURCE + "\n").encode()
        if args[:2] == ["gh", "api"]:
            if "POST" in args:
                self.ref = {"object": {"type": "commit", "sha": SOURCE}}
                return self.ref
            path = args[2]
            if "/git/ref/" in path:
                return copy.deepcopy(self.ref)
            if "/releases/tags/" in path:
                return copy.deepcopy(self.release) if self.release and not self.release["draft"] else None
            if "/releases?" in path:
                matches = [copy.deepcopy(self.release)] if self.release else []
                if self.duplicate_release:
                    matches.append(copy.deepcopy(self.duplicate_release))
                # Include another tag on a separate page to exercise pagination.
                return [[{"id": 1, "tag_name": "v1.0.0"}], matches]
            if "/assets?" in path:
                return [copy.deepcopy(list(self.assets.values()))]
            raise AssertionError(args)
        action = args[2]
        if action == "create":
            self.complete_release(draft=True)
            self.assets = {}
            self.assertIn("--verify-tag", args)
            self.assertIn("--latest=false", args)
            notes = Path(args[args.index("--notes-file") + 1]).read_text()
            self.assertIn(SOURCE, notes)
        elif action == "upload":
            name = Path(args[4]).name
            self.assertNotIn("--clobber", args)
            self.assets[name] = {"id": 100, "name": name, "state": "uploaded", "digest": self.hashes[name]}
        elif action == "edit":
            self.release["draft"] = False
        else:
            raise AssertionError(args)
        return b""

    def writes(self):
        return [args for args in self.calls if "POST" in args or args[:2] == ["gh", "release"]]

    def test_new_release_publishes_exact_source_and_three_verified_assets(self):
        receipt = m.reconcile(SOURCE, self.root, self.run_cli, self.get)
        self.assertEqual(receipt["source"], SOURCE)
        self.assertEqual(set(self.assets), set(m.ASSETS))
        self.assertFalse(self.release["draft"])
        self.assertEqual(len(self.gets), 2)
        self.assertTrue((self.root / "release-receipt.json").exists())
        self.assertFalse(any("/releases/tags/" in arg for args in self.calls for arg in args))

    def test_draft_is_discovered_when_release_by_tag_returns_not_found(self):
        self.complete_release(draft=True)
        self.assertIsNone(self.run_cli(["gh", "api", f"repos/{m.REPO}/releases/tags/{m.TAG}"]))
        m.reconcile(SOURCE, self.root, self.run_cli, self.get)
        self.assertFalse(self.release["draft"])
        self.assertFalse(any("create" in args for args in self.writes()))

    def test_duplicate_draft_and_published_tag_refuses_writes(self):
        self.complete_release()
        self.duplicate_release = {**self.release, "id": 43, "draft": True}
        with self.assertRaisesRegex(RuntimeError, "Multiple releases"):
            m.reconcile(SOURCE, self.root, self.run_cli, self.get)
        self.assertEqual(self.writes(), [])

    def test_partial_draft_retry_uploads_only_missing_asset(self):
        self.complete_release(draft=True)
        del self.assets["styles.css"]
        m.reconcile(SOURCE, self.root, self.run_cli, self.get)
        uploads = [args for args in self.writes() if "upload" in args]
        self.assertEqual(len(uploads), 1)
        self.assertTrue(uploads[0][4].endswith("styles.css"))

    def test_published_retry_still_checks_backend_source_and_hashes(self):
        self.complete_release()
        m.reconcile(SOURCE, self.root, self.run_cli, self.get)
        self.assertEqual(self.writes(), [])
        self.assertEqual(len(self.gets), 2)
        self.assertTrue(any("/assets?" in arg for args in self.calls for arg in args))

    def test_wrong_source_wrong_asset_or_missing_published_asset_blocks_writes(self):
        for drift in ("source", "asset", "missing"):
            with self.subTest(drift=drift):
                self.calls = []
                self.complete_release()
                if drift == "source":
                    self.ref["object"]["sha"] = "2" * 40
                elif drift == "asset":
                    self.assets["main.js"]["digest"] = "sha256:" + "2" * 64
                else:
                    del self.assets["main.js"]
                with self.assertRaises(RuntimeError):
                    m.reconcile(SOURCE, self.root, self.run_cli, self.get)
                self.assertEqual(self.writes(), [])

    def test_backend_replay_or_wrong_local_version_blocks_remote_work(self):
        with self.assertRaises(RuntimeError):
            m.reconcile(SOURCE, self.root, self.run_cli, lambda _: b'{"replay_version":1,"replay_epoch":"bad"}')
        self.assertEqual(self.calls, [])
        (self.root / "manifest.json").write_text('{"version":"2.1.0-beta.6"}')
        with self.assertRaises(RuntimeError):
            m.reconcile(SOURCE, self.root, self.run_cli, self.get)
        self.assertEqual(self.calls, [])

    def test_old_asset_without_digest_is_hashed_using_supported_cli(self):
        payload = b"synthetic-artifact"
        with patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, payload, b"")) as run:
            observed = m.asset_digest({"id": 9}, self.run_cli)
        self.assertEqual(observed, "sha256:" + hashlib.sha256(payload).hexdigest())
        self.assertIn("Accept: application/octet-stream", run.call_args.args[0])

    def test_permission_error_is_not_mistaken_for_missing_release(self):
        with patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"HTTP 403")):
            with self.assertRaises(RuntimeError):
                m.command(["gh", "api", "repos/example/releases"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
