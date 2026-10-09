"""Reject executable/unbounded release input; derive exact versioned routes."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from release_plan import load


class ReleasePlan(unittest.TestCase):
    def setUp(self):
        self.side = (
            "server"
            if "baseline"
            in json.loads(
                (Path(__file__).parent.parent / "release/plan.json").read_text()
            )
            else "client"
        )
        self.plan = json.loads(
            (Path(__file__).parent.parent / "release/plan.json").read_text()
        )
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "plan.json"

    def parse(self, value):
        self.path.write_text(json.dumps(value))
        return load(self.path, self.side)

    def test_current_plan_is_recovery_only_and_url_derived_from_client_version(self):
        result = self.parse(self.plan)
        self.assertFalse(result["allow_new_build"])
        self.assertEqual(
            result["backend"],
            "https://v2-1-0-beta-8---keepsidianserver-i55qr5tvea-uc.a.run.app",
        )

    def test_next_release_requires_only_data_changes(self):
        value = copy.deepcopy(self.plan)
        value.update(
            server_source="a" * 40,
            client_source="b" * 40,
            server_version="0.1.0-beta.9",
            client_version="2.1.0-beta.9",
            revision="keepsidianserver-beta9-aaaaaaa",
            image_tag="beta9-aaaaaaa",
            allow_new_build=True,
        )
        result = self.parse(value)
        self.assertIn("v2-1-0-beta-9---", result["backend"])
        self.assertEqual(result["tags"], ["sv0-1-0-beta-9", "v2-1-0-beta-9"])

    def test_unknown_fields_injection_mutable_sources_and_budget_expansion_fail(self):
        cases = [
            ("command", "curl evil | bash"),
            ("max_image_bytes", 2**40),
            ("server_source", "main"),
            ("client_version", "2.1.0; echo evil"),
            ("revision", "different-service-aaaaaaa"),
            ("model", "other-model"),
            ("allow_new_build", "true"),
            ("schema", True),
            ("recovery_cores", ["main"]),
            ("recovery_prefixes", ["../other"]),
        ]
        for key, value in cases:
            with self.subTest(key=key):
                candidate = {**self.plan, key: value}
                with self.assertRaises(ValueError):
                    self.parse(candidate)


if __name__ == "__main__":
    unittest.main()
