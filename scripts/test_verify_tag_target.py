import unittest
from verify_tag_target import verify


class TagTarget(unittest.TestCase):
    def test_equal_workflow_tree_on_different_commits(self):
        verify(
            "lc0rp/KeepSydian",
            "a" * 40,
            "b" * 40,
            lambda _: {
                "truncated": False,
                "tree": [
                    {"path": ".github/workflows", "type": "tree", "sha": "c" * 40}
                ],
            },
        )

    def test_changed_or_truncated_tree_fails_before_mutation(self):
        with self.assertRaisesRegex(RuntimeError, "different workflow tree"):
            verify(
                "lc0rp/KeepSydian",
                "a" * 40,
                "b" * 40,
                lambda path: {
                    "truncated": False,
                    "tree": [
                        {"path": ".github/workflows", "type": "tree", "sha": path}
                    ],
                },
            )
        with self.assertRaisesRegex(RuntimeError, "Incomplete"):
            verify(
                "lc0rp/KeepSydian", "a" * 40, "b" * 40, lambda _: {"truncated": True}
            )


if __name__ == "__main__":
    unittest.main()
