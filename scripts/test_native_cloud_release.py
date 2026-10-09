from copy import deepcopy
import base64
import json
from unittest.mock import patch
from pathlib import Path
import unittest
import native_cloud_release as n

BUILD = "12345678-1234-1234-1234-123456789abc"
SERVER = "sv0.1.0-beta.8b"
CLIENT = "v2.1.0-beta.8b"


def fixture():
    build = {
        "id": BUILD,
        "name": f"projects/{n.PROJECT}/locations/global/builds/{BUILD}",
        "projectId": n.PROJECT,
        "buildTriggerId": n.TRIGGER,
        "serviceAccount": n.BUILD_SA,
        "status": "SUCCESS",
        "substitutions": {
            "TAG_NAME": SERVER,
            "COMMIT_SHA": "a" * 40,
            "REPO_NAME": "KeepSidianServer",
            "REPO_FULL_NAME": "lc0rp/KeepSidianServer",
        },
        "sourceProvenance": {
            "resolvedRepoSource": {
                "commitSha": "a" * 40,
                "projectId": n.PROJECT,
                "repoName": "github_lc0rp_KeepSidianServer",
            }
        },
        "results": {
            "images": [
                {"name": n.IMAGE + ":build-" + BUILD, "digest": "sha256:" + "b" * 64}
            ]
        },
    }
    identity = n.build_identity(build, BUILD, SERVER)
    revision = {
        "name": n.RESOURCE + "/revisions/" + identity["revision"],
        "serviceAccount": n.RUNTIME,
        "labels": {"commit-sha": "a" * 40},
        "conditions": [{"type": "Ready", "state": "CONDITION_SUCCEEDED"}],
        "containers": [
            {
                "image": identity["image"],
                "env": [
                    {"name": "OPENAI_MODEL", "value": "gpt-6-luna"},
                    {"name": "KEEPSIDIAN_REPLAY_ENABLED", "value": "true"},
                ],
            }
        ],
    }

    def route(rev, tag="", percent=0):
        return {
            "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
            "revision": rev,
            "tag": tag,
            "percent": percent,
        }

    service = {
        "etag": "one",
        "template": {"serviceAccount": n.RUNTIME},
        "traffic": [
            route("old-default", "", 100),
            route("old-default", "v2-1-0-beta-8"),
            route(identity["revision"], n.alias(SERVER, "sv")),
        ],
    }
    service["trafficStatuses"] = deepcopy(service["traffic"])
    proof = {
        "schema": 1,
        "root_build_id": BUILD,
        "origin_build_id": "",
        "source": "a" * 40,
        "image": identity["image"],
        "config_digest": "sha256:" + "c" * 64,
        "compressed_bytes": 100,
        "baseline": {"test": "baseline"},
    }
    build["steps"] = [{"id": "capture-push", "status": "SUCCESS"}]
    build["results"]["buildStepOutputs"] = [
        base64.b64encode(json.dumps(proof).encode()).decode()
    ]
    return build, revision, service


class FakeCloud:
    def __init__(self, mode="ok"):
        self.build, self.revision, self.service = fixture()
        self.before = deepcopy(self.service)
        self.mode = mode
        self.writes = []
        self.smokes = []
        self.runtime = {
            "spec": {
                "containers": [
                    {
                        "image": self.revision["containers"][0]["image"],
                        "env": [
                            {
                                "name": "secret",
                                "valueFrom": {
                                    "secretKeyRef": {"name": "test-only", "key": "1"}
                                },
                            }
                        ],
                    }
                ]
            },
            "metadata": {"annotations": {"runtime": "test"}},
        }
        self.runtime_expected = deepcopy(self.runtime)
        self.network = {"metadata": {"annotations": {"ingress": "test"}}}
        self.network_expected = deepcopy(self.network)

    def read(self, url, body=None):
        if body is not None:
            self.writes.append(deepcopy(body))
            assert body["etag"] == "one"
            assert set(body) == {"name", "etag", "traffic"}
            if self.mode == "rejected":
                raise RuntimeError("409")
            self.service["traffic"] = deepcopy(body["traffic"])
            self.service["trafficStatuses"] = deepcopy(body["traffic"])
            if self.mode == "drift":
                self.service["traffic"][0]["percent"] = 99
            if self.mode == "template":
                self.service["template"]["serviceAccount"] = "other"
            if self.mode == "lost":
                raise TimeoutError("accepted but response lost")
            return {"name": "operation"}
        if url == n.build_url(BUILD):
            return deepcopy(self.build)
        if url.startswith(n.V1 + "/revisions/"):
            return deepcopy(self.runtime)
        if url == n.V1 + "/services/" + n.SERVICE:
            return deepcopy(self.network)
        if "/revisions/" in url:
            return deepcopy(self.revision)
        if url == n.RUN:
            return deepcopy(self.service)
        raise AssertionError(url)

    def run(self, tag=CLIENT, smoke=None):
        spec = deepcopy(self.runtime_expected["spec"])
        spec["containers"][0].pop("image")
        with patch.multiple(
            n,
            PROFILE_SPEC_HASH=n.fingerprint(spec),
            PROFILE_ANNOTATIONS_HASH=n.fingerprint(
                self.runtime_expected["metadata"]["annotations"]
            ),
            SERVICE_ANNOTATIONS_HASH=n.fingerprint(
                self.network_expected["metadata"]["annotations"]
            ),
        ):
            return n.map_client(
                BUILD,
                SERVER,
                tag,
                self.read,
                smoke or self.smokes.append,
                lambda _: None,
            )


class NativeReleaseTests(unittest.TestCase):
    def test_mapping_preserves_all_routes_and_template(self):
        c = FakeCloud()
        result = c.run()
        self.assertEqual(len(c.writes), 1)
        self.assertEqual(c.writes[0]["traffic"][:-1], c.before["traffic"])
        self.assertEqual(c.service["template"], c.before["template"])
        self.assertEqual(c.smokes, [result["backend"]])

    def test_recovery_reconciles_lost_response_and_next_run_has_no_write(self):
        c = FakeCloud("lost")
        c.run()
        c.run()
        self.assertEqual(len(c.writes), 1)

    def test_client_only_reuses_native_build_and_revision(self):
        c = FakeCloud()
        first = c.run()
        second = c.run("v2.1.0-beta.8c")
        self.assertEqual(first["build_id"], second["build_id"])
        self.assertEqual(first["image"], second["image"])
        self.assertEqual(len(c.writes), 2)
        self.assertEqual(len(c.service["traffic"]), len(c.before["traffic"]) + 2)

    def test_conflict_never_repoints(self):
        c = FakeCloud()
        c.service["traffic"].append(
            {
                "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
                "revision": "different",
                "tag": n.alias(CLIENT, "v"),
            }
        )
        c.service["trafficStatuses"] = deepcopy(c.service["traffic"])
        with self.assertRaisesRegex(RuntimeError, "conflict"):
            c.run()
        self.assertEqual(c.writes, [])

    def test_rejected_or_ambiguous_write_never_resubmitted(self):
        c = FakeCloud("rejected")
        with self.assertRaisesRegex(RuntimeError, "unresolved"):
            c.run()
        self.assertEqual(len(c.writes), 1)
        self.assertEqual(c.smokes, [])

    def test_concurrent_change_stops_after_one_write(self):
        for mode in ("drift", "template"):
            with self.subTest(mode=mode):
                c = FakeCloud(mode)
                with self.assertRaisesRegex(RuntimeError, "Concurrent"):
                    c.run()
                self.assertEqual(len(c.writes), 1)
                self.assertEqual(c.smokes, [])

    def test_native_identity_mismatches_fail_before_write(self):
        for key in ("id", "projectId", "buildTriggerId", "serviceAccount", "status"):
            with self.subTest(key=key):
                c = FakeCloud()
                c.build[key] = "wrong"
                with self.assertRaises(RuntimeError):
                    c.run()
                self.assertEqual(c.writes, [])
        for key in ("TAG_NAME", "COMMIT_SHA", "REPO_NAME", "REPO_FULL_NAME"):
            with self.subTest(key=key):
                c = FakeCloud()
                c.build["substitutions"][key] = "wrong"
                with self.assertRaises(RuntimeError):
                    c.run()
                self.assertEqual(c.writes, [])

    def test_missing_native_provenance_is_not_replaced_by_substitutions(self):
        c = FakeCloud()
        c.build["sourceProvenance"] = {}
        with self.assertRaisesRegex(RuntimeError, "provenance"):
            c.run()
        self.assertEqual(c.writes, [])

    def test_image_digest_mismatch_fails_before_mapping(self):
        c = FakeCloud()
        c.revision["containers"][0]["image"] = n.IMAGE + "@sha256:" + "c" * 64
        with self.assertRaises(RuntimeError):
            c.run()
        self.assertEqual(c.writes, [])

    def test_not_ready_wrong_runtime_and_model_fail(self):
        for key in ("ready", "runtime", "model"):
            c = FakeCloud()
            if key == "ready":
                c.revision["conditions"] = []
            if key == "runtime":
                c.revision["serviceAccount"] = "wrong"
            if key == "model":
                c.revision["containers"][0]["env"][0]["value"] = "wrong"
            with self.assertRaises(RuntimeError):
                c.run()
            self.assertEqual(c.writes, [])

    def test_unconverged_and_missing_semantic_alias_stop(self):
        for key in ("etag", "trafficStatuses", "reconciling"):
            c = FakeCloud()
            c.service[key] = (
                True
                if key == "reconciling"
                else ([] if key == "trafficStatuses" else "")
            )
            with self.assertRaises(RuntimeError):
                c.run()
            self.assertEqual(c.writes, [])

    def test_smoke_failure_does_not_undo_mapping_or_retry_write(self):
        c = FakeCloud()

        def fail(_):
            raise RuntimeError("smoke failed")

        with self.assertRaisesRegex(RuntimeError, "smoke failed"):
            c.run(smoke=fail)
        c.run()
        self.assertEqual(len(c.writes), 1)

    def test_full_runtime_and_network_drift_stop_before_write(self):
        for kind in ("secret", "resource", "volume", "network", "annotation"):
            c = FakeCloud()
            if kind == "secret":
                c.runtime["spec"]["containers"][0]["env"][0]["valueFrom"][
                    "secretKeyRef"
                ]["name"] = "wrong"
            if kind == "resource":
                c.runtime["spec"]["containers"][0]["resources"] = {
                    "limits": {"memory": "8Gi"}
                }
            if kind == "volume":
                c.runtime["spec"]["volumes"] = [{"name": "extra"}]
            if kind == "network":
                c.network["metadata"]["annotations"]["ingress"] = "all"
            if kind == "annotation":
                c.runtime["metadata"]["annotations"]["runtime"] = "wrong"
            with self.assertRaisesRegex(RuntimeError, "profile"):
                c.run()
            self.assertEqual(c.writes, [])

    def test_observed_canonical_project_number_is_same_fixed_project(self):
        c = FakeCloud()
        c.build["name"] = f"projects/{n.PROJECT_NUMBER}/locations/global/builds/{BUILD}"
        c.run()
        self.assertEqual(len(c.writes), 1)
        c = FakeCloud()
        c.build["name"] = f"projects/999999999999/locations/global/builds/{BUILD}"
        with self.assertRaisesRegex(RuntimeError, "name/location"):
            c.run()
        self.assertEqual(c.writes, [])

    def test_wrong_native_repository_and_location_fail(self):
        for field in ("repoName", "projectId"):
            c = FakeCloud()
            c.build["sourceProvenance"]["resolvedRepoSource"][field] = "wrong"
            with self.assertRaises(RuntimeError):
                c.run()
            self.assertEqual(c.writes, [])
        c = FakeCloud()
        c.build["name"] = c.build["name"].replace("/global/", "/other/")
        with self.assertRaises(RuntimeError):
            c.run()
        self.assertEqual(c.writes, [])

    def test_missing_checkpoint_cannot_be_rebuilt_or_mapped(self):
        c = FakeCloud()
        c.build["results"]["buildStepOutputs"] = []
        with self.assertRaisesRegex(RuntimeError, "checkpoint"):
            c.run()
        self.assertEqual(c.writes, [])

    def test_checked_in_policy_is_disabled(self):
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            n.load_policy(
                Path(__file__).parents[1] / "release/cloud-release-policy.json"
            )

    def test_invalid_version_and_build_rejected_without_api(self):
        for tag in ("v2.1.0/evil", "v2.1.0?x", "v02.1.0", "main"):
            with self.assertRaises(ValueError):
                n.alias(tag, "v")
        with self.assertRaises(ValueError):
            n.build_url("../other")


if __name__ == "__main__":
    unittest.main()
