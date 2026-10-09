import base64
from copy import deepcopy
import json
import unittest
import native_cloud_release as n
from test_native_cloud_release import BUILD, SERVER, fixture

RECOVERY = "22345678-1234-1234-1234-123456789abc"
THIRD = "32345678-1234-1234-1234-123456789abc"


def put(build, proof):
    build["results"]["buildStepOutputs"] = [
        base64.b64encode(json.dumps(proof).encode()).decode()
    ]


def recovery(origin, new_id):
    result = deepcopy(origin)
    result["id"] = new_id
    result["name"] = f"projects/{n.PROJECT}/locations/global/builds/{new_id}"
    result["substitutions"]["_RECOVER_BUILD_ID"] = origin["id"]
    result["status"] = "SUCCESS"
    result["results"]["images"][0]["name"] = n.IMAGE + ":build-" + new_id
    proof = n.checkpoint(origin)
    proof["origin_build_id"] = origin["id"]
    put(result, proof)
    return result


class NativeLineageTests(unittest.TestCase):
    def setUp(self):
        original, _, _ = fixture()
        original["status"] = "FAILURE"
        # Native final images[] can be absent when deploy or smoke fails.
        original["results"].pop("images")
        self.original = original
        self.fixed = recovery(
            {
                **original,
                "results": {
                    **original["results"],
                    "images": [
                        {
                            "name": n.IMAGE + ":build-" + BUILD,
                            "digest": "sha256:" + "b" * 64,
                        }
                    ],
                },
            },
            RECOVERY,
        )
        self.builds = {BUILD: original, RECOVERY: self.fixed}

    def read(self, url):
        return deepcopy(self.builds[url.rsplit("/", 1)[-1]])

    def test_terminal_deploy_failure_uses_original_image_baseline_revision(self):
        identity, proof = n.resolve_build(self.read, RECOVERY, SERVER)
        self.assertEqual(
            identity["revision"], "keepsidianserver-b-" + BUILD.replace("-", "")[:16]
        )
        self.assertEqual(identity["image"], n.checkpoint(self.original)["image"])
        self.assertEqual(proof["baseline"], n.checkpoint(self.original)["baseline"])

    def test_repeated_recovery_preserves_root_lineage(self):
        self.fixed["status"] = "TIMEOUT"
        self.builds[THIRD] = recovery(self.fixed, THIRD)
        identity, _ = n.resolve_build(self.read, THIRD, SERVER)
        self.assertEqual(identity["root_build_id"], BUILD)

    def test_client_rejects_failed_build_even_if_revision_ready(self):
        with self.assertRaisesRegex(RuntimeError, "successful"):
            n.resolve_build(self.read, BUILD, SERVER)

    def test_server_may_resume_failed_checkpoint_without_final_image_results(self):
        identity, _ = n.resolve_build(self.read, BUILD, SERVER, require_success=False)
        self.assertEqual(identity["image"], n.checkpoint(self.original)["image"])

    def test_image_source_baseline_and_root_tampering_rejected(self):
        for key, value in [
            ("image", n.IMAGE + "@sha256:" + "d" * 64),
            ("source", "d" * 40),
            ("baseline", {"changed": True}),
            ("root_build_id", THIRD),
            ("config_digest", "sha256:" + "d" * 64),
            ("compressed_bytes", 101),
        ]:
            with self.subTest(key=key):
                original = deepcopy(self.fixed)
                proof = n.checkpoint(self.fixed)
                proof[key] = value
                put(self.fixed, proof)
                with self.assertRaises(RuntimeError):
                    n.resolve_build(self.read, RECOVERY, SERVER)
                self.fixed.clear()
                self.fixed.update(original)

    def test_wrong_origin_substitution_rejected(self):
        self.fixed["substitutions"]["_RECOVER_BUILD_ID"] = THIRD
        with self.assertRaisesRegex(RuntimeError, "origin"):
            n.resolve_build(self.read, RECOVERY, SERVER)

    def test_missing_or_failed_checkpoint_refuses_rebuild(self):
        for status in ("FAILURE", "WORKING"):
            self.original["steps"][0]["status"] = status
            with self.assertRaisesRegex(RuntimeError, "checkpoint"):
                n.resolve_build(self.read, RECOVERY, SERVER)

    def test_running_original_refuses_concurrent_recovery(self):
        self.original["status"] = "WORKING"
        with self.assertRaisesRegex(RuntimeError, "terminal"):
            n.resolve_build(self.read, RECOVERY, SERVER)

    def test_wrong_repo_even_with_matching_substitutions_rejected(self):
        self.original["sourceProvenance"]["resolvedRepoSource"]["repoName"] = "evil"
        with self.assertRaisesRegex(RuntimeError, "repository"):
            n.resolve_build(self.read, RECOVERY, SERVER)

    def test_cycle_and_too_long_lineage_rejected(self):
        proof = n.checkpoint(self.original)
        proof["origin_build_id"] = RECOVERY
        put(self.original, proof)
        self.original["substitutions"]["_RECOVER_BUILD_ID"] = RECOVERY
        with self.assertRaisesRegex(RuntimeError, "Cyclic"):
            n.resolve_build(self.read, RECOVERY, SERVER)


if __name__ == "__main__":
    unittest.main()
