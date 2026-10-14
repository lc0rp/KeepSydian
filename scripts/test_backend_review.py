"""Review assertion is bounded and honest; failed private verification emits none."""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from backend_review import canonical, prepare, tuple_digest, validate
from release_plan import load


class ReviewerHandoff(unittest.TestCase):
    def setUp(self):
        self.plan = load(Path(__file__).parent.parent / "release/plan.json", "client")
        self.now = datetime(2026, 10, 9, 18, tzinfo=timezone.utc)
        self.review = {
            "schema": 1,
            "authority": "authorized-reviewer",
            "reviewer_id": "2609441",
            "reviewed_at": "2026-10-09T18:00:00Z",
            "tuple_sha256": tuple_digest(self.plan),
            "evidence_sha256": "a" * 64,
        }

    def check(self, value=None, **kwargs):
        return validate(
            json.dumps(self.review if value is None else value),
            self.plan,
            kwargs.get("actor", "2609441"),
            kwargs.get("trigger", "lc0rp"),
            kwargs.get("now", self.now),
        )

    def test_handoff_is_explicitly_not_independent_private_proof(self):
        self.assertIs(self.check()["independent_backend_verification"], False)

    def test_rejects_malformed_unbounded_unknown_or_duplicate_data(self):
        for raw in ("", "[1]", "x" * 1025, '{"schema":1,"schema":1}'):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                validate(raw, self.plan, "2609441", "lc0rp", self.now)
        for key, value in (
            ("image", "private"),
            ("schema", True),
            ("evidence_sha256", "x"),
            ("reviewer_id", 2609441),
            ("authority", "verified-machine-proof"),
            ("reviewed_at", "2026-10-09"),
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.check({**self.review, key: value})

    def test_each_shared_tuple_field_is_bound(self):
        from backend_review import TUPLE_KEYS

        for key in TUPLE_KEYS:
            original = self.plan[key]
            self.plan[key] = "different"
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.check()
            self.plan[key] = original

    def test_wrong_actor_or_rerunner_is_rejected(self):
        for actor, trigger in (("1", "lc0rp"), ("2609441", "other"), ("", "")):
            with self.assertRaises(ValueError):
                self.check(actor=actor, trigger=trigger)

    def test_future_and_expired_assertions_fail_including_after_build(self):
        for offset in (-61, 21601):
            with self.assertRaisesRegex(ValueError, "future-dated or expired"):
                self.check(now=self.now + timedelta(seconds=offset))
        self.check(now=self.now + timedelta(seconds=21600))

    def test_private_evidence_is_retained_but_not_in_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "private"

            def verifier(plan, run, artifact, head, target, read):
                target.mkdir(exist_ok=True)
                (target / "backend-verification.json").write_text(
                    json.dumps(
                        {
                            "private_runtime": "DO-NOT-PUBLISH",
                            "run": run,
                            "artifact": artifact,
                        }
                    )
                )

            read = Mock(return_value={"id": 2609441, "login": "lc0rp"})
            result = prepare(
                self.plan, 1, 2, "a" * 40, destination, read, verifier, self.now
            )
            read.assert_called_once_with("user")
            self.assertNotIn("DO-NOT-PUBLISH", result)
            self.assertEqual(set(json.loads(result)), set(self.review))
            self.assertEqual(result, canonical(json.loads(result)).decode())
            self.assertTrue((destination / "backend-verification.json").exists())
            self.assertEqual(destination.stat().st_mode & 0o777, 0o700)
            with self.assertRaisesRegex(ValueError, "fresh private"):
                prepare(
                    self.plan, 1, 2, "a" * 40, destination, read, verifier, self.now
                )

    def test_public_checkout_destination_fails_before_any_read(self):
        destination = Path(__file__).parent.parent / "must-not-create-private-proof"
        read = Mock()
        with self.assertRaisesRegex(ValueError, "outside the public"):
            prepare(self.plan, 1, 2, "a" * 40, destination, read, Mock(), self.now)
        read.assert_not_called()
        self.assertFalse(destination.exists())

    def test_failed_verifier_or_wrong_auth_cannot_emit_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "private"
            verifier = Mock(side_effect=RuntimeError("canonical provenance failed"))
            read = Mock(return_value={"id": 2609441, "login": "lc0rp"})
            with self.assertRaisesRegex(RuntimeError, "provenance"):
                prepare(
                    self.plan, 1, 2, "a" * 40, destination, read, verifier, self.now
                )
            self.assertFalse((destination / "review-handoff.json").exists())
            verifier.reset_mock()
            read.return_value = {"id": 1, "login": "other"}
            destination = Path(directory) / "other-private"
            with self.assertRaisesRegex(ValueError, "authentication"):
                prepare(
                    self.plan, 1, 2, "a" * 40, destination, read, verifier, self.now
                )
            verifier.assert_not_called()


if __name__ == "__main__":
    unittest.main()
