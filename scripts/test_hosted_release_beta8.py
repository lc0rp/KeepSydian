"""Offline publisher checks. Sockets and real commands are blocked."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "release_beta8", Path(__file__).with_name("hosted-release-beta8.py")
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SOURCE = "1" * 40
EPOCH = "a" * 32


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for target in ("socket.create_connection", "socket.socket", "subprocess.run"):
            blocker = patch(
                target,
                side_effect=AssertionError("No network or real commands allowed"),
            )
            blocker.start()
            self.addCleanup(blocker.stop)
        for name in ("manifest.json", "package.json"):
            self.write_json(name, {"version": m.VERSION, "minAppVersion": "1.6.5"})
        self.write_json(
            "package-lock.json",
            {"version": m.VERSION, "packages": {"": {"version": m.VERSION}}},
        )
        self.write_json("versions.json", {m.VERSION: "1.6.5"})
        self.bundle = (
            'var rawServerUrl = "' + m.BACKEND + '";\n'
            '// src/services/recovery-uat.ts\nvar import_obsidian10 = require("obsidian");\nvar enabled = false;\n'
        )
        (self.root / "main.js").write_text(self.bundle)
        (self.root / "styles.css").write_text(".plugin { color: inherit; }")
        self.hashes = m.validate(self.root)
        self.calls, self.gets = [], []
        self.ref = self.release = self.duplicate_release = None
        self.assets = {}
        self.list_lag = self.id_lag = 0
        self.ambiguous = False
        self.wrong_created = False
        self.drift_after_create = False

    def write_json(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def get(self, url):
        self.gets.append(url)
        if url.endswith("/enrich/local/capabilities"):
            return json.dumps(
                {"version": 1, "epoch": "c" * 32, "issued_at_ms": len(self.gets)}
            ).encode()
        return (
            json.dumps({"replay_version": 1, "replay_epoch": EPOCH}).encode()
            if url.endswith("/capabilities")
            else b"OK"
        )

    def complete_release(self, draft=False):
        self.ref = {"object": {"type": "commit", "sha": SOURCE}}
        self.release = {
            "id": 42,
            "tag_name": m.TAG,
            "draft": draft,
            "prerelease": True,
            "html_url": f"https://github.com/{m.REPO}/releases/tag/{m.TAG}",
        }
        self.assets = {
            name: {
                "id": i,
                "name": name,
                "state": "uploaded",
                "digest": self.hashes[name],
            }
            for i, name in enumerate(m.ASSETS, start=100)
        }

    def run_cli(self, args):
        self.calls.append(args)
        if args[0] == "git":
            return (SOURCE + "\n").encode()
        self.assertEqual(args[:2], ["gh", "api"])
        if "--method" in args:
            method = args[args.index("--method") + 1]
            path = args[args.index("--method") + 2]
            if path.endswith("/git/refs"):
                self.ref = {"object": {"type": "commit", "sha": SOURCE}}
                return copy.deepcopy(self.ref)
            if path.endswith("/releases"):
                self.complete_release(draft=True)
                self.assets = {}
                self.assertIn("make_latest=false", args)
                if self.ambiguous:
                    raise RuntimeError("Ambiguous POST transport failure")
                if self.wrong_created:
                    return None
                if self.drift_after_create:
                    self.ref["object"]["sha"] = "2" * 40
                return copy.deepcopy(self.release)
            if "uploads.github.com" in path:
                self.assertEqual(method, "POST")
                name = path.split("name=")[1]
                self.assertNotIn(name, self.assets)
                self.assets[name] = {
                    "id": 100,
                    "name": name,
                    "state": "uploaded",
                    "digest": self.hashes[name],
                }
                return copy.deepcopy(self.assets[name])
            if method == "PATCH":
                self.assertTrue(path.endswith("/releases/42"))
                self.assertIn("make_latest=false", args)
                self.release["draft"] = False
                return copy.deepcopy(self.release)
            raise AssertionError(args)
        path = args[2]
        if "/git/ref/" in path:
            return copy.deepcopy(self.ref)
        if "/releases?" in path:
            if self.list_lag:
                self.list_lag -= 1
                return [[]]
            matches = [copy.deepcopy(self.release)] if self.release else []
            if self.duplicate_release:
                matches.append(copy.deepcopy(self.duplicate_release))
            return [[{"id": 1, "tag_name": "v1.0.0"}], matches]
        if "/assets?" in path:
            return [copy.deepcopy(list(self.assets.values()))]
        if path.endswith("/releases/42"):
            if self.id_lag:
                self.id_lag -= 1
                return None
            return copy.deepcopy(self.release)
        raise AssertionError(args)

    def writes(self):
        return [args for args in self.calls if "--method" in args]

    def creations(self):
        return [args for args in self.writes() if args[4].endswith("/releases")]

    def reconcile(self):
        return m.reconcile(SOURCE, self.root, self.run_cli, self.get)

    def test_new_release_uses_canonical_id_not_immediate_list(self):
        self.list_lag = 10
        self.id_lag = 2
        receipt = self.reconcile()
        self.assertEqual(receipt["release_id"], 42)
        self.assertEqual(receipt["replay_epoch"], EPOCH)
        self.assertEqual(len(self.creations()), 1)
        self.assertEqual(set(self.assets), set(m.ASSETS))
        self.assertFalse(self.release["draft"])
        self.assertEqual(len(self.gets), 5)
        self.assertEqual(
            sum("/releases?" in arg for args in self.calls for arg in args), 1
        )

    def test_same_version_other_source_artifact_is_rejected(self):
        proof = {
            "source": "9" * 40,
            "version": m.VERSION,
            "backend": m.BACKEND,
            "assets": self.hashes,
        }
        (self.root / "release-build.json").write_text(json.dumps(proof))
        with self.assertRaisesRegex(RuntimeError, "different source"):
            m.verify_build(self.root, SOURCE, self.hashes)
        proof["source"] = SOURCE
        (self.root / "release-build.json").write_text(json.dumps(proof))
        m.verify_build(self.root, SOURCE, self.hashes)
        proof["assets"]["main.js"] = "sha256:" + "f" * 64
        (self.root / "release-build.json").write_text(json.dumps(proof))
        with self.assertRaisesRegex(RuntimeError, "different source"):
            m.verify_build(self.root, SOURCE, m.validate(self.root))

    def test_lost_tag_response_reconciles_exact_ref(self):
        original = self.run_cli

        def lost(args):
            result = original(args)
            if "POST" in args and args[4].endswith("/git/refs"):
                raise TimeoutError("accepted tag response lost")
            return result

        receipt = m.reconcile(SOURCE, self.root, lost, self.get)
        self.assertEqual(receipt["source"], SOURCE)
        self.assertEqual(
            sum(args[4].endswith("/git/refs") for args in self.writes()), 1
        )

    def test_interruption_after_tag_can_resume_with_restored_intent(self):
        original = self.run_cli

        def interrupted(args):
            result = original(args)
            if "POST" in args and args[4].endswith("/git/refs"):
                raise KeyboardInterrupt("runner stopped after tag acceptance")
            return result

        with self.assertRaises(KeyboardInterrupt):
            m.reconcile(SOURCE, self.root, interrupted, self.get)
        self.assertEqual(
            json.loads((self.root / "release-intent.json").read_text())["status"],
            "tag-started",
        )
        self.reconcile()
        self.assertEqual(len(self.creations()), 1)
        self.assertEqual(
            sum(args[4].endswith("/git/refs") for args in self.writes()), 1
        )

    def test_ref_denial_retains_intent_before_first_write(self):
        original = self.run_cli

        def denied(args):
            if "POST" in args and args[4].endswith("/git/refs"):
                self.assertTrue((self.root / "release-intent.json").exists())
                raise RuntimeError("HTTP 403")
            return original(args)

        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            m.reconcile(SOURCE, self.root, denied, self.get)
        self.assertEqual(self.creations(), [])
        self.assertIsNone(self.ref)

    def test_restored_tag_intent_different_asset_bytes_blocks_release_creation(self):
        (self.root / "release-intent.json").write_text(
            json.dumps(
                {
                    "source": SOURCE,
                    "tag": m.TAG,
                    "status": "tag-confirmed",
                    "assets": {},
                }
            )
        )
        with self.assertRaisesRegex(RuntimeError, "different source or assets"):
            self.reconcile()
        self.assertEqual(self.writes(), [])

    def test_partial_draft_retry_uploads_missing_only(self):
        self.complete_release(draft=True)
        del self.assets["styles.css"]
        self.reconcile()
        uploads = [args for args in self.writes() if "uploads.github.com" in args[4]]
        self.assertEqual(len(uploads), 1)
        self.assertTrue(uploads[0][4].endswith("name=styles.css"))
        self.assertEqual(self.creations(), [])

    def test_published_replay_has_zero_remote_mutations(self):
        self.complete_release()
        self.reconcile()
        self.assertEqual(self.writes(), [])
        self.assertEqual(len(self.gets), 5)

    def test_duplicate_releases_block_all_mutations_even_without_ref(self):
        self.complete_release()
        self.ref = None
        self.duplicate_release = {**self.release, "id": 43, "draft": True}
        with self.assertRaisesRegex(RuntimeError, "Multiple releases"):
            self.reconcile()
        self.assertEqual(self.writes(), [])

    def test_ref_asset_published_missing_wrong_metadata_blocks_writes(self):
        for drift in (
            "source",
            "asset",
            "missing",
            "prerelease",
            "tag",
            "duplicate_asset",
            "unexpected_asset",
        ):
            with self.subTest(drift=drift):
                self.calls = []
                self.complete_release()
                if drift == "source":
                    self.ref["object"]["sha"] = "2" * 40
                elif drift == "asset":
                    self.assets["main.js"]["digest"] = "sha256:" + "2" * 64
                elif drift == "missing":
                    del self.assets["main.js"]
                elif drift == "prerelease":
                    self.release["prerelease"] = False
                elif drift == "tag":
                    self.release["id"] = 43  # canonical ID cannot match expected 42
                elif drift == "duplicate_asset":
                    self.assets["second"] = self.assets["main.js"]
                else:
                    self.assets["extra"] = {"name": "extra.zip"}
                with self.assertRaises((RuntimeError, AssertionError)):
                    self.reconcile()
                self.assertEqual(self.writes(), [])

    def test_created_ref_drift_stops_before_upload_or_publication(self):
        self.drift_after_create = True
        with self.assertRaisesRegex(RuntimeError, "unreviewed source"):
            self.reconcile()
        self.assertFalse(
            any("uploads.github.com" in arg for args in self.calls for arg in args)
        )
        self.assertFalse(any("PATCH" in args for args in self.calls))

    def test_ambiguous_post_never_recreates_when_list_lags(self):
        self.ambiguous = True
        with self.assertRaisesRegex(RuntimeError, "Ambiguous POST"):
            self.reconcile()
        self.list_lag = 10
        with self.assertRaisesRegex(RuntimeError, "Prior creation is ambiguous"):
            self.reconcile()
        self.assertEqual(len(self.creations()), 1)
        self.assertEqual(self.assets, {})

    def test_malformed_created_response_never_recreates(self):
        self.wrong_created = True
        with self.assertRaisesRegex(RuntimeError, "prerelease metadata"):
            self.reconcile()
        self.list_lag = 10
        with self.assertRaisesRegex(RuntimeError, "Prior creation is ambiguous"):
            self.reconcile()
        self.assertEqual(len(self.creations()), 1)

    def test_fresh_runner_after_ambiguous_creation_cannot_recreate(self):
        self.ambiguous = True
        with self.assertRaisesRegex(RuntimeError, "Ambiguous POST"):
            self.reconcile()
        (self.root / "release-intent.json").unlink()
        self.list_lag = 10
        with self.assertRaisesRegex(
            RuntimeError, "Existing source tag has no visible release"
        ):
            self.reconcile()
        self.assertEqual(len(self.creations()), 1)

    def test_ambiguous_creation_recovers_once_release_is_discoverable(self):
        self.ambiguous = True
        with self.assertRaisesRegex(RuntimeError, "Ambiguous POST"):
            self.reconcile()
        self.reconcile()
        self.assertEqual(len(self.creations()), 1)
        self.assertFalse(self.release["draft"])

    def test_exhausted_canonical_read_retains_id_and_resumes_without_list(self):
        self.id_lag = m.READ_ATTEMPTS
        with self.assertRaisesRegex(
            RuntimeError, "Canonical release readback unavailable"
        ):
            self.reconcile()
        self.assertEqual(
            json.loads((self.root / "release-intent.json").read_text())["release_id"],
            42,
        )
        self.list_lag = 10
        self.reconcile()
        self.assertEqual(len(self.creations()), 1)

    def test_bad_versions_minimum_url_and_uat_block_remote_work(self):
        original = {
            name: (self.root / name).read_text()
            for name in (
                "manifest.json",
                "package.json",
                "package-lock.json",
                "versions.json",
                "main.js",
            )
        }
        cases = [
            ("manifest.json", '{"version":"wrong"}'),
            ("package.json", '{"version":"wrong"}'),
            (
                "package-lock.json",
                json.dumps(
                    {"version": m.VERSION, "packages": {"": {"version": "wrong"}}}
                ),
            ),
            (
                "package-lock.json",
                json.dumps(
                    {"version": "wrong", "packages": {"": {"version": m.VERSION}}}
                ),
            ),
            (
                "manifest.json",
                json.dumps({"version": m.VERSION, "minAppVersion": "1.0.0"}),
            ),
            ("versions.json", json.dumps({m.VERSION: "1.0.0"})),
            (
                "main.js",
                self.bundle + '\n"https://keepsidianserver-i55qr5tvea-uc.a.run.app"',
            ),
            ("main.js", self.bundle.replace("beta-8", "beta-6b")),
            ("main.js", self.bundle.replace("enabled = false", "enabled = true")),
        ]
        for name, payload in cases:
            with self.subTest(name=name, payload=payload):
                (self.root / name).write_text(payload)
                with self.assertRaises(RuntimeError):
                    self.reconcile()
                self.assertEqual(self.calls, [])
                self.assertEqual(self.gets, [])
                (self.root / name).write_text(original[name])

    def test_asset_size_and_empty_guards(self):
        (self.root / "styles.css").write_bytes(b"")
        with self.assertRaisesRegex(RuntimeError, "Empty or oversized"):
            m.validate(self.root)
        (self.root / "styles.css").write_bytes(b"x" * m.MAX_BYTES)
        with self.assertRaisesRegex(RuntimeError, "Combined release assets"):
            m.validate(self.root)
        (self.root / "styles.css").write_bytes(b"x" * (m.MAX_BYTES + 1))
        with self.assertRaisesRegex(RuntimeError, "Empty or oversized"):
            m.validate(self.root)

    def test_capability_profile_epoch_or_change_blocks_remote_work(self):
        for value in (
            {"replay_version": 0, "replay_epoch": None},
            {"replay_version": True, "replay_epoch": EPOCH},
            {"replay_version": 1, "replay_epoch": "bad"},
            {"replay_version": 1, "replay_epoch": EPOCH, "extra": 1},
        ):
            with self.assertRaises(RuntimeError):
                m.reconcile(
                    SOURCE,
                    self.root,
                    self.run_cli,
                    lambda _: json.dumps(value).encode(),
                )
            self.assertEqual(self.calls, [])
        replies = iter(
            [
                json.dumps({"replay_version": 1, "replay_epoch": EPOCH}).encode(),
                b"OK",
                json.dumps({"replay_version": 1, "replay_epoch": "b" * 32}).encode(),
            ]
        )
        with self.assertRaisesRegex(RuntimeError, "epoch changed"):
            m.reconcile(SOURCE, self.root, self.run_cli, lambda _: next(replies))
        self.assertEqual(self.calls, [])

    def test_redirect_and_http_error_do_not_retry(self):
        with self.assertRaisesRegex(RuntimeError, "must not redirect"):
            m.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://elsewhere.example"
            )
        opener = unittest.mock.MagicMock()
        opener.open.return_value.__enter__.return_value.status = 503
        with patch.object(m, "build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "HTTP 200"):
                m.backend()
        self.assertEqual(opener.open.call_count, 1)

    def test_old_asset_missing_digest_uses_injected_supported_cli(self):
        payload = b"synthetic-artifact"
        calls = []
        result = m.asset_digest({"id": 9}, lambda args: calls.append(args) or payload)
        self.assertEqual(result, "sha256:" + hashlib.sha256(payload).hexdigest())
        self.assertIn("Accept: application/octet-stream", calls[0])

    def test_only_read_404_is_absent_write404_and_permission_fail(self):
        for method, status in ((None, 404), ("POST", 404), (None, 403)):
            args = ["gh", "api", "repos/example/releases"]
            if method:
                args += ["--method", method]
            with patch.object(
                m.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 1, b"", f"HTTP {status}".encode()
                ),
            ):
                if method is None and status == 404:
                    self.assertIsNone(m.command(args))
                else:
                    with self.assertRaises(RuntimeError):
                        m.command(args)

    def test_missing_or_foreign_enrichment_capability_blocks_publication(self):
        for bad in (
            {"version": 1, "epoch": "c" * 32},
            {"version": True, "epoch": "c" * 32, "issued_at_ms": 123},
            {"version": 1, "epoch": "c" * 32, "issued_at_ms": True},
            {"version": 1, "epoch": "d" * 32, "issued_at_ms": 124},
        ):
            count = []

            def get(url):
                result = self.get(url)
                if url.endswith("/enrich/local/capabilities"):
                    count.append(url)
                    if len(count) == 2:
                        return json.dumps(bad).encode()
                return result

            with self.assertRaises(RuntimeError):
                m.reconcile(SOURCE, self.root, self.run_cli, get)
            self.assertEqual(self.writes(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
