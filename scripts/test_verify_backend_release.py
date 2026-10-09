"""Canonical backend proof rejects wrong source, workflow, artifacts and failed runs."""

import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from release_plan import load
from verify_backend_release import verify, REPO


class BackendProof(unittest.TestCase):
    def setUp(self):
        self.plan = load(Path(__file__).parent.parent / "release/plan.json", "client")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.destination = Path(self.temp.name) / "proof"
        self.head = "a" * 40
        self.receipt = {
            "source": self.plan["server_source"],
            "client_source": self.plan["client_source"],
            "client_version": self.plan["client_version"],
            "server_version": self.plan["server_version"],
            "revision": self.plan["revision"],
            "model": self.plan["model"],
            "tags": self.plan["tags"],
            "runtime": "keepsidian-runtime@lc0rp-labs.iam.gserviceaccount.com",
            "replay_enabled": True,
            "prior_routing_preserved": True,
            "status": "verified",
            "provider_calls": 0,
            "backend_gets": 10,
            "image": "us-central1-docker.pkg.dev/lc0rp-labs/cloud-run-source-deploy/keepsidianserver@sha256:"
            + "b" * 64,
        }
        self.jobs = {
            "total_count": 3,
            "jobs": [
                {"name": "release / deploy", "conclusion": "success", "run_attempt": 1},
                {
                    "name": "release / publish-refs",
                    "conclusion": "success",
                    "run_attempt": 1,
                },
                {
                    "name": "release / dispatch-client",
                    "conclusion": "success",
                    "run_attempt": 1,
                },
            ],
        }
        self.run = {
            "id": 1,
            "head_sha": self.head,
            "head_branch": "main",
            "event": "workflow_dispatch",
            "status": "completed",
            "conclusion": "success",
            "run_attempt": 1,
            "repository": {"full_name": REPO},
            "referenced_workflows": [
                {
                    "path": REPO
                    + "/.github/workflows/release-cloudrun-core.yml@"
                    + self.plan["backend_core"],
                    "sha": self.plan["backend_core"],
                }
            ],
        }

    def read(self, path, binary=False):
        if "/jobs?" in path:
            return copy.deepcopy(self.jobs)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as output:
            output.writestr("backend-release-receipt.json", json.dumps(self.receipt))
        payload = stream.getvalue()
        if binary:
            return payload
        if path.endswith("/runs/1"):
            return copy.deepcopy(self.run)
        return {
            "id": 2,
            "name": "keepsidian-server-evidence-1-1",
            "expired": False,
            "workflow_run": {"id": 1, "head_sha": self.head},
            "size_in_bytes": len(payload),
            "digest": "sha256:" + hashlib.sha256(payload).hexdigest(),
        }

    def verify(self):
        return verify(self.plan, 1, 2, self.head, self.destination, self.read)

    def test_lost_handoff_response_does_not_invalidate_verified_backend_stages(self):
        self.run["conclusion"] = "failure"
        self.jobs["jobs"][2]["conclusion"] = "failure"
        self.assertEqual(self.verify(), self.receipt)

    def test_partial_ref_job_rerun_accepts_original_successful_deploy_artifact(self):
        self.run["run_attempt"] = 2
        self.jobs["jobs"][1]["run_attempt"] = 2
        self.assertEqual(self.verify(), self.receipt)

    def test_stale_artifact_after_deploy_rerun_is_rejected(self):
        self.run["run_attempt"] = 2
        self.jobs["jobs"][0]["run_attempt"] = 2
        with self.assertRaisesRegex(RuntimeError, "latest successful"):
            self.verify()

    def test_bound_backend_receipt_passes(self):
        self.assertEqual(self.verify(), self.receipt)

    def test_handoff_waits_for_backend_terminal_success(self):
        self.run.update(status="in_progress", conclusion=None)
        waits = []

        def finish(seconds):
            waits.append(seconds)
            self.run.update(status="completed", conclusion="success")

        self.assertEqual(
            verify(self.plan, 1, 2, self.head, self.destination, self.read, finish),
            self.receipt,
        )
        self.assertEqual(waits, [10])

    def test_backend_wait_is_bounded_and_timeout_cannot_publish(self):
        self.run.update(status="in_progress", conclusion=None)
        waits = []
        with self.assertRaisesRegex(RuntimeError, "successfully"):
            verify(
                self.plan, 1, 2, self.head, self.destination, self.read, waits.append
            )
        self.assertEqual(waits, [10] * 18)
        self.assertFalse(self.destination.exists())

    def test_failed_backend_never_downloads_or_builds_client(self):
        self.run["conclusion"] = "failure"
        self.jobs["jobs"][0]["conclusion"] = "failure"
        with self.assertRaisesRegex(RuntimeError, "successfully"):
            self.verify()

    def test_receipt_model_source_or_revision_drift_stops_client(self):
        for key in ("source", "client_source", "model", "revision", "image"):
            with self.subTest(key=key):
                old = self.receipt[key]
                self.receipt[key] = "wrong"
                self.destination = Path(self.temp.name) / key
                with self.assertRaisesRegex(
                    RuntimeError, "reviewed client/backend tuple"
                ):
                    self.verify()
                self.receipt[key] = old

    def test_other_workflow_with_convincing_receipt_is_rejected(self):
        self.run["referenced_workflows"][0]["sha"] = "c" * 40
        with self.assertRaisesRegex(RuntimeError, "provenance"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
