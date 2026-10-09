"""Validation must remain a separate least-permission graph, not a dry-run flag."""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).parent.parent
SIDE = (
    "server" if (ROOT / ".github/workflows/release-server.yml").exists() else "client"
)


def jobs(text):
    found = {}
    current = None
    for line in text.split("jobs:\n", 1)[1].splitlines():
        match = re.fullmatch(r"  ([a-z0-9-]+):", line)
        if match:
            current = match[1]
            found[current] = ""
        else:
            found[current] += line + "\n"
    return found


class ReadOnlyGraph(unittest.TestCase):
    def setUp(self):
        core = (
            "release-cloudrun-core.yml"
            if SIDE == "server"
            else "release-client-core.yml"
        )
        wrapper = "release-server.yml" if SIDE == "server" else "release-client.yml"
        self.core = (ROOT / ".github/workflows" / core).read_text()
        self.wrapper = (ROOT / ".github/workflows" / wrapper).read_text()

    def test_validation_jobs_have_no_write_token_or_app_credentials(self):
        for graph in (jobs(self.core), jobs(self.wrapper)):
            body = graph["validate-beta8"]
            permissions = dict(
                re.findall(r"^      ([\w-]+): (read|write)$", body, re.M)
            )
            expected = {"contents": "read", "actions": "read"}
            if SIDE == "server":
                expected["id-token"] = "write"
            self.assertEqual(permissions, expected)
            self.assertNotIn("secrets", body)
            self.assertNotIn("create-github-app-token", body)
            self.assertNotIn("private_key", body)

    def test_all_mutating_jobs_require_explicit_release_mode(self):
        for graph in (jobs(self.core), jobs(self.wrapper)):
            for name, body in graph.items():
                if name == "validate-beta8":
                    self.assertIn("inputs.mode == 'validate-beta8'", body)
                else:
                    self.assertIn("    if: inputs.mode == 'release' &&", body, name)
        self.assertIn("default: validate-beta8", self.wrapper)
        self.assertIn(
            "inputs.expected_head == github.sha", jobs(self.wrapper)["validate-beta8"]
        )

    def test_validation_has_fixed_entrypoint_timeout_and_distinct_receipt(self):
        body = jobs(self.core)["validate-beta8"]
        self.assertIn("timeout-minutes: 10", body)
        self.assertIn(
            "run: python3 -B scripts/validate_beta8_readonly.py " + SIDE, body
        )
        self.assertIn("validation/validation-receipt.json", body)
        self.assertNotIn("release-beta8.py", body)
        self.assertNotIn("hosted-release-beta8.py", body)
        self.assertNotIn("backend-release-receipt", body)
        self.assertNotIn("setup-gcloud", body)
        self.assertNotIn("npm", body)
        self.assertNotIn("docker", body)

    def test_two_button_graph_has_no_apps_or_automatic_cross_repo_dispatch(self):
        for text in (self.core, self.wrapper):
            for forbidden in (
                "create-github-app-token",
                "private_key",
                "CLIENT_RELEASE_ACTOR",
                "backend_app",
                "client_dispatch",
                "dispatch_release_client",
                "verify_backend_release.py",
            ):
                self.assertNotIn(forbidden, text)
            for body in jobs(text).values():
                self.assertIn("github.actor_id == '2609441'", body)
                self.assertIn("github.triggering_actor == 'lc0rp'", body)
        if SIDE == "client":
            for name in ("build", "publish"):
                body = jobs(self.core)[name]
                self.assertIn("backend_review.py check", body)
                self.assertIn(
                    "KEEPSIDIAN_BACKEND_REVIEW: ${{ inputs.backend_review }}", body
                )
                self.assertNotIn("backend-proof", body)
        self.assertIn(
            "inputs.expected_head == github.sha", jobs(self.wrapper)["release"]
        )


if __name__ == "__main__":
    unittest.main()
