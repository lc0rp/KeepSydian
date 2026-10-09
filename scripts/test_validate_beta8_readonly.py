"""Offline state/provenance faults and real bounded-pipe transport tests."""

import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import validate_beta8_readonly as m


class Validation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.destination = Path(self.temp.name) / "validation"
        contract = copy.deepcopy(m.CONTRACT)
        self.contract = contract
        for key, value in (
            ("CONTRACT", contract),
            ("SERVER", contract.get("server", {})),
            ("CLIENT", contract.get("client", {})),
        ):
            edit = patch.object(m, key, value)
            edit.start()
            self.addCleanup(edit.stop)
        self.payloads = {}
        self.metadata = {}
        self.requests = []
        self.commands = []
        self.cloud_service_reads = 0
        self.drift_after_smoke = False
        for side in (m.SIDE,):
            proof = contract[side]
            if side == "server":
                receipt = proof["image_receipt"]
                self.manifest = json.dumps(
                    {
                        "config": {"digest": receipt["config_digest"], "size": 1},
                        "layers": [{"size": receipt["compressed_bytes"] - 1}],
                    }
                ).encode()
                image = m.IMAGE.split("@")[0] + "@" + m.digest(self.manifest)
                for key, value in (
                    ("IMAGE", image),
                    ("DIGEST", m.digest(self.manifest)),
                ):
                    edit = patch.object(m, key, value)
                    edit.start()
                    self.addCleanup(edit.stop)
                receipt["image"] = image
                proof["expected"]["template"]["spec"]["containers"][0]["image"] = image
                files = {
                    name: b"synthetic retained diagnostic" for name in proof["files"]
                }
                files["image-release-receipt.json"] = json.dumps(receipt).encode()
            else:
                files = {
                    name: ("synthetic asset " + name).encode()
                    for name in proof["files"]
                }
                for name, content in files.items():
                    proof["assets"][name].update(
                        size=len(content), digest=m.digest(content)
                    )
                    self.payloads[
                        f"repos/{proof['repository']}/releases/assets/{proof['assets'][name]['id']}"
                    ] = content
            proof["files"] = {
                name: m.digest(content) for name, content in files.items()
            }
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                for name, content in files.items():
                    archive.writestr(name, content)
            proof["archive_digest"] = m.digest(stream.getvalue())
            prefix = f"repos/{proof['repository']}"
            self.payloads[f"{prefix}/actions/artifacts/{proof['artifact_id']}/zip"] = (
                stream.getvalue()
            )
            self.metadata[f"{prefix}/actions/runs/{proof['run_id']}"] = {
                "id": proof["run_id"],
                "head_sha": proof["head_sha"],
                "head_branch": "main",
                "event": "workflow_dispatch",
                "status": "completed",
                "conclusion": "failure",
                "run_attempt": 1,
                "repository": {"full_name": proof["repository"]},
                "referenced_workflows": [
                    {"path": proof["core"], "sha": proof["core"].split("@")[1]}
                ],
            }
            self.metadata[f"{prefix}/actions/artifacts/{proof['artifact_id']}"] = {
                "id": proof["artifact_id"],
                "name": f"{proof['artifact_prefix']}-{proof['run_id']}-1",
                "expired": False,
                "workflow_run": {"id": proof["run_id"], "head_sha": proof["head_sha"]},
                "size_in_bytes": len(stream.getvalue()),
                "digest": proof["archive_digest"],
            }
        if m.SIDE == "client":
            proof = contract["client"]
            prefix = f"repos/{proof['repository']}"
            self.ref = {
                "object": {
                    "type": "commit",
                    "sha": proof["source"],
                    "url": f"https://api.github.com/{prefix}/git/commits/{proof['source']}",
                }
            }
            self.release = {
                "id": proof["release_id"],
                "tag_name": proof["tag"],
                "draft": False,
                "prerelease": True,
                "assets": [
                    {"name": name, **asset} for name, asset in proof["assets"].items()
                ],
            }
            self.metadata[f"{prefix}/git/ref/tags/{proof['tag']}"] = self.ref
            self.metadata[f"{prefix}/releases/{proof['release_id']}"] = self.release
        if m.SIDE == "server":
            expected = contract["server"]["expected"]
            self.service = {
                "metadata": {
                    "annotations": expected["annotations"],
                    "labels": expected["labels"],
                },
                "spec": {
                    "template": copy.deepcopy(expected["template"]),
                    "traffic": copy.deepcopy(expected["traffic"]),
                },
                "status": {
                    "traffic": copy.deepcopy(expected["traffic"]),
                    "latestReadyRevisionName": "older",
                },
            }
            self.revision = {
                "metadata": {"name": m.REVISION},
                "spec": copy.deepcopy(expected["template"]["spec"]),
                "status": {
                    "imageDigest": m.IMAGE,
                    "conditions": [{"type": "Ready", "status": "True"}],
                },
            }
        for edit in (
            patch.object(m, "bounded_gh_get", side_effect=self.gh),
            patch.object(m, "build_opener"),
            patch.dict(m.os.environ, {"ACCESS_TOKEN": "synthetic-access-token"}),
            patch(
                "socket.socket", side_effect=AssertionError("No real network allowed")
            ),
        ):
            result = edit.start()
            self.addCleanup(edit.stop)
            if getattr(edit, "attribute", "") == "build_opener":
                result.return_value.open.side_effect = self.http

    def gh(self, args):
        self.commands.append(args)
        self.assertEqual(args[:4], ["gh", "api", "--method", "GET"])
        path = args[4]
        return (
            self.payloads[path]
            if path in self.payloads
            else json.dumps(self.metadata[path]).encode()
        )

    def http(self, request, timeout):
        self.requests.append(request)
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertEqual(timeout, 15)
        url = request.full_url
        if url == m.SERVICE_URL:
            self.cloud_service_reads += 1
            if self.drift_after_smoke and self.cloud_service_reads == 2:
                self.service["status"]["traffic"].pop()
            payload = json.dumps(self.service).encode()
        elif url == m.REVISION_URL:
            payload = json.dumps(self.revision).encode()
        elif url == m.MANIFEST_URL:
            payload = self.manifest
        else:
            self.assertIsNone(request.get_header("Authorization"))
            if url.endswith("/keep/sync/capabilities"):
                payload = json.dumps(
                    {"replay_version": 1, "replay_epoch": "a" * 32}
                ).encode()
            elif url.endswith("/keep/enrich/local/capabilities"):
                payload = json.dumps(
                    {"version": 1, "epoch": "b" * 32, "issued_at_ms": 1}
                ).encode()
            else:
                payload = b"subscribe"
        stream = io.BytesIO(payload)
        stream.status = 200
        return stream

    def validate(self, side):
        return m.validate(side, self.destination, m.Reads(side))

    @unittest.skipUnless(m.SIDE == "server", "Server-only validator")
    def test_server_verifies_exact_mapped_state_with_only_bounded_gets(self):
        receipt = self.validate("server")
        self.assertEqual(
            (
                receipt["application_gets"],
                receipt["cloud_gets"],
                receipt["github_gets"],
            ),
            (10, 5, 3),
        )
        self.assertEqual(receipt["production_mutations"], 0)
        self.assertFalse(receipt["release_proof"])
        self.assertEqual(receipt["origin"]["run_id"], 37881620450)

    @unittest.skipUnless(m.SIDE == "client", "Client-only validator")
    def test_client_verifies_published_bytes_without_backend_credentials_or_app(self):
        with patch.dict(m.os.environ, {}, clear=True):
            receipt = self.validate("client")
        self.assertEqual(
            (
                receipt["application_gets"],
                receipt["cloud_gets"],
                receipt["github_gets"],
            ),
            (5, 0, 8),
        )
        self.assertFalse(receipt["release_proof"])

    @unittest.skipUnless(m.SIDE == "server", "Server-only validator")
    def test_original_failed_run_is_not_relabelled_release_success(self):
        receipt = self.validate("server")
        self.assertEqual(receipt["status"], "read-only beta.8 observations verified")
        self.assertFalse((self.destination / "backend-release-receipt.json").exists())

    @unittest.skipUnless(m.SIDE == "server", "Server-only validator")
    def test_runtime_or_route_drift_stops_before_application_requests(self):
        self.service["spec"]["template"]["spec"]["serviceAccountName"] = "unexpected"
        with self.assertRaisesRegex(RuntimeError, "cannot repair"):
            self.validate("server")
        self.assertEqual(len(self.requests), 2)
        self.assertFalse((self.destination / "validation-receipt.json").exists())

    @unittest.skipUnless(m.SIDE == "server", "Server-only validator")
    def test_post_smoke_route_drift_cannot_report_success(self):
        self.drift_after_smoke = True
        with self.assertRaisesRegex(RuntimeError, "cannot repair"):
            self.validate("server")
        self.assertFalse((self.destination / "validation-receipt.json").exists())

    @unittest.skipUnless(m.SIDE == "server", "Server-only validator")
    def test_wrong_registry_manifest_stops_before_smoke(self):
        self.manifest += b" "
        with self.assertRaisesRegex(RuntimeError, "manifest differs"):
            self.validate("server")
        self.assertEqual(len(self.requests), 3)

    @unittest.skipUnless(m.SIDE == "server", "Server-only validator")
    def test_expired_artifact_or_different_frozen_digest_stops_before_cloud(self):
        proof = self.contract["server"]
        meta = self.metadata[
            f"repos/{proof['repository']}/actions/artifacts/{proof['artifact_id']}"
        ]
        meta["expired"] = True
        with self.assertRaisesRegex(RuntimeError, "expired"):
            self.validate("server")
        self.assertFalse(self.requests)
        self.assertFalse((self.destination / "validation-receipt.json").exists())

    @unittest.skipUnless(m.SIDE == "client", "Client-only validator")
    def test_asset_substitution_or_wrong_source_stops_before_smoke(self):
        self.release["assets"][0]["id"] += 1
        with self.assertRaisesRegex(RuntimeError, "asset identity"):
            self.validate("client")
        self.assertFalse(self.requests)

    @unittest.skipUnless(m.SIDE == "client", "Client-only validator")
    def test_wrong_published_source_fails_before_smoke(self):
        self.ref["object"]["sha"] = "0" * 40
        with self.assertRaisesRegex(RuntimeError, "source tag"):
            self.validate("client")
        self.assertFalse(self.requests)
        self.assertFalse((self.destination / "validation-receipt.json").exists())

    @unittest.skipUnless(m.SIDE == "server", "Server-only validator")
    def test_frozen_file_hash_cannot_be_replaced_by_convincing_canonical_archive(self):
        self.contract["server"]["files"]["image-ref.txt"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(RuntimeError, "frozen contract"):
            self.validate("server")
        self.assertFalse(self.requests)

    def test_closed_transport_rejects_foreign_urls_methods_and_over_budget(self):
        reader = m.Reads(m.SIDE)
        for url in (
            m.SERVICE_URL + ":delete",
            "https://example.com",
            m.BASES[0] + "/keep/enrich",
        ):
            with self.assertRaisesRegex(RuntimeError, "allowlist"):
                reader.get(url)
        with self.assertRaises(TypeError):
            reader.get(m.SERVICE_URL, method="PATCH")
        with self.assertRaisesRegex(RuntimeError, "allowlist"):
            reader.github(
                "repos/lc0rp/KeepSydian/actions/workflows/release-client.yml/dispatches"
            )
        with self.assertRaisesRegex(RuntimeError, "allowlist"):
            reader.github(next(iter(reader.json_paths)), binary=True)
        if m.SIDE == "server":
            reader.cloud_gets = 5
            with self.assertRaisesRegex(RuntimeError, "Five cloud"):
                reader.get(m.SERVICE_URL)
        else:
            with self.assertRaisesRegex(RuntimeError, "allowlist"):
                reader.get(m.SERVICE_URL)
        reader.application_gets = 10 if m.SIDE == "server" else 5
        with self.assertRaisesRegex(RuntimeError, "Application GET"):
            reader.get(m.BASES[1] + m.PATHS[0])
        reader.github_gets = 8
        with self.assertRaisesRegex(RuntimeError, "budget"):
            reader.github(next(iter(reader.json_paths)))
        with self.assertRaises(ValueError):
            m.Reads("client" if m.SIDE == "server" else "server")
        self.assertFalse(self.requests)
        self.assertFalse(self.commands)

    @unittest.skipUnless(m.SIDE == "client", "Client-only validator")
    def test_expired_final_deadline_cannot_write_success_receipt(self):
        reader = m.Reads("client")
        actual_get = reader.get

        def expire_on_final_get(url):
            payload = actual_get(url)
            if reader.application_gets == 5:
                reader.started -= 481
            return payload

        with patch.object(reader, "get", side_effect=expire_on_final_get):
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                m.validate("client", self.destination, reader)
        self.assertFalse((self.destination / "validation-receipt.json").exists())

    def test_redirects_and_expired_deadline_fail_without_transport(self):
        with self.assertRaisesRegex(RuntimeError, "redirect"):
            m.NoRedirect().redirect_request(
                None, None, 302, None, None, "https://evil.example"
            )
        reads = m.Reads(m.SIDE)
        reads.started -= 481
        with self.assertRaisesRegex(RuntimeError, "deadline"):
            reads.get(m.SERVICE_URL)
        self.assertFalse(self.requests)


class BoundedPipe(unittest.TestCase):
    def run_child(self, code):
        # A real local process exercises pipe byte/deadline handling; no gh/network.
        launch = subprocess.Popen

        def fake_gh(args, **kwargs):
            return launch([sys.executable, "-c", code], **kwargs)

        with patch.object(m.subprocess, "Popen", side_effect=fake_gh):
            return m.bounded_gh_get(
                [
                    "gh",
                    "api",
                    "--method",
                    "GET",
                    next(iter(m.Reads(m.SIDE).json_paths)),
                ]
            )

    def test_mutating_or_unrelated_commands_never_start(self):
        with patch.object(m.subprocess, "Popen") as launch:
            for args in (
                ["docker", "push", "image"],
                ["gh", "api", "--method", "POST", "repos/lc0rp/KeepSydian/git/refs"],
            ):
                with self.assertRaisesRegex(ValueError, "GET commands"):
                    m.bounded_gh_get(args)
            launch.assert_not_called()

    def test_successful_pipe_read(self):
        self.assertEqual(self.run_child("print('ok', end='')"), b"ok")

    def test_oversized_output_is_killed_before_full_read(self):
        with patch.object(m, "GITHUB_BYTES", 64):
            with self.assertRaisesRegex(RuntimeError, "byte/time"):
                self.run_child("import sys; sys.stdout.write('x' * 1000000)")

    def test_silent_process_times_out_and_failed_process_hides_stderr(self):
        with patch.object(m, "GITHUB_SECONDS", 0.05):
            with self.assertRaisesRegex(RuntimeError, "byte/time"):
                self.run_child("import time; time.sleep(10)")
        with self.assertRaisesRegex(RuntimeError, "byte/time") as error:
            self.run_child(
                "import sys; print('sensitive diagnostic', file=sys.stderr); sys.exit(1)"
            )
        self.assertNotIn("sensitive", str(error.exception))


if __name__ == "__main__":
    unittest.main()
