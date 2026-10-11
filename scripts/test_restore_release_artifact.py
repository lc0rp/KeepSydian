"""Offline artifact integrity and provenance faults (no release or cloud writes)."""

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from restore_release_artifact import restore

REPO = "lc0rp/KeepSidianServer"
HEAD = "a" * 40
CORE = REPO + "/.github/workflows/release-cloudrun-core.yml@" + "b" * 40


class ArtifactRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.destination = Path(self.temp.name) / "recovered"
        self.run = {
            "id": 1,
            "head_sha": HEAD,
            "head_branch": "main",
            "event": "workflow_dispatch",
            "status": "completed",
            "run_attempt": 2,
            "repository": {"full_name": REPO},
            "referenced_workflows": [{"path": CORE, "sha": "b" * 40}],
        }
        self.artifact = {
            "id": 2,
            "name": "proof-1-1",
            "expired": False,
            "workflow_run": {"id": 1, "head_sha": HEAD},
        }
        self.archive({"image-release-receipt.json": b'{"source":"reviewed"}'})

    def archive(self, files):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as output:
            for name, value in files.items():
                output.writestr(name, value)
        self.payload = stream.getvalue()
        self.artifact.update(
            digest="sha256:" + hashlib.sha256(self.payload).hexdigest(),
            size_in_bytes=len(self.payload),
        )

    def read(self, path, binary=False):
        if binary:
            return self.payload
        return self.run if path.endswith("/runs/1") else self.artifact

    def restore(self):
        return restore(
            REPO,
            1,
            2,
            HEAD,
            CORE,
            "proof",
            {"image-release-receipt.json"},
            {"image-release-receipt.json"},
            self.destination,
            self.read,
        )

    def test_exact_prior_attempt_has_digest_and_file_receipt(self):
        value = self.restore()
        self.assertEqual(value["attempt"], 1)
        self.assertEqual(
            json.loads((self.destination / "artifact-origin.json").read_text()), value
        )

    def test_wrong_head_core_event_run_or_expiry_writes_nothing(self):
        mutations = [
            (self.run, "head_sha", "c" * 40),
            (self.run, "event", "pull_request"),
            (self.run, "referenced_workflows", []),
            (self.run, "status", "in_progress"),
            (self.artifact, "expired", True),
            (self.artifact, "id", 3),
            (self.artifact, "name", "proof-1-3"),
            (self.artifact, "workflow_run", {"id": 9, "head_sha": HEAD}),
        ]
        for obj, key, wrong in mutations:
            with self.subTest(key=key):
                old = obj[key]
                obj[key] = wrong
                with self.assertRaisesRegex(RuntimeError, "provenance"):
                    self.restore()
                self.assertFalse(self.destination.exists())
                obj[key] = old

    def test_digest_mismatch_and_zip_traversal_block_all_writes(self):
        self.payload += b"changed"
        with self.assertRaisesRegex(RuntimeError, "digest"):
            self.restore()
        self.archive({"../escape": b"bad", "image-release-receipt.json": b"{}"})
        with self.assertRaisesRegex(RuntimeError, "archive members"):
            self.restore()
        self.assertFalse(self.destination.exists())

    def test_existing_destination_never_clobbered(self):
        self.restore()
        with self.assertRaisesRegex(RuntimeError, "empty"):
            self.restore()


if __name__ == "__main__":
    unittest.main()
