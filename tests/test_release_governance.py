from __future__ import annotations

import unittest
import json
from pathlib import Path

from scripts.release_steward import (
    CleanupState,
    ReleaseEvidence,
    WorktreeState,
    cut_release,
    evaluate_release,
    plan_cleanup,
)


ROOT = Path(__file__).resolve().parents[1]
SHA_A = "a" * 40
SHA_B = "b" * 40


def evidence(**changes: object) -> ReleaseEvidence:
    values: dict[str, object] = {
        "version": "0.3.0",
        "branch": "build/v0.3.0",
        "target_sha": SHA_A,
        "remote_tip_sha": SHA_A,
        "release_page": "# v0.3.0\n\nA dependable procedure.\n",
        "review_text": f"reviewed: {SHA_A}\nverdict: ship\n",
        "tree_clean": True,
        "changed_paths_from_review": frozenset(),
        "review_is_direct_parent": False,
    }
    values.update(changes)
    return ReleaseEvidence(**values)


class ReleaseEvidenceTests(unittest.TestCase):
    def test_missing_review_is_a_classified_refusal(self) -> None:
        decision = evaluate_release(evidence(review_text=None))
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "MISSING_REVIEW")

    def test_hold_verdict_is_a_classified_refusal(self) -> None:
        decision = evaluate_release(
            evidence(review_text=f"reviewed: {SHA_A}\nverdict: hold\n")
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "HOLD_VERDICT")

    def test_stale_review_is_a_classified_refusal(self) -> None:
        decision = evaluate_release(
            evidence(review_text=f"reviewed: {SHA_B}\nverdict: ship\n")
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "STALE_REVIEW")

    def test_current_ship_verdict_allows_only_the_matching_tag(self) -> None:
        decision = evaluate_release(evidence())
        self.assertTrue(decision.allowed)
        self.assertEqual((decision.tag, decision.target_sha), ("v0.3.0", SHA_A))

    def test_one_direct_evidence_only_commit_may_follow_review(self) -> None:
        decision = evaluate_release(
            evidence(
                target_sha=SHA_B,
                remote_tip_sha=SHA_B,
                review_text=f"reviewed: {SHA_A}\nverdict: ship\n",
                review_is_direct_parent=True,
                changed_paths_from_review=frozenset(
                    {
                        "docs/releases/v0.3.0/REVIEW.md",
                        "docs/releases/v0.3.0/RELEASE.md",
                    }
                ),
            )
        )
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.target_sha, SHA_B)

    def test_a_different_version_cannot_be_cut_from_the_line(self) -> None:
        decision = evaluate_release(evidence(version="0.4.0"))
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "WRONG_BUILD_BRANCH")


class FakeGit:
    def __init__(self, *, local: str | None = None, remote: str | None = None) -> None:
        self.local = local
        self.remote = remote
        self.writes: list[tuple[str, ...]] = []

    def local_tag_target(self, _tag: str) -> str | None:
        return self.local

    def remote_tag_target(self, _tag: str) -> str | None:
        return self.remote

    def create_tag(self, tag: str, target: str, message: str) -> None:
        self.writes.append(("tag", tag, target, message))
        self.local = target

    def push_tag(self, tag: str) -> None:
        self.writes.append(("push-tag", tag))
        self.remote = self.local


class ReleaseCutTests(unittest.TestCase):
    def test_ship_creates_and_pushes_only_the_intended_tag(self) -> None:
        git = FakeGit()
        gate_calls: list[str] = []
        decision = cut_release(
            evidence(),
            git,  # type: ignore[arg-type]
            [lambda: gate_calls.append("verify") or 0],
            dry_run=False,
        )
        self.assertTrue(decision.allowed)
        self.assertEqual(gate_calls, ["verify"])
        self.assertEqual([write[0] for write in git.writes], ["tag", "push-tag"])
        self.assertEqual(git.writes[0][1:3], ("v0.3.0", SHA_A))

    def test_conflicting_tag_refuses_before_running_a_gate(self) -> None:
        git = FakeGit(remote=SHA_B)
        gate_calls: list[str] = []
        decision = cut_release(
            evidence(),
            git,  # type: ignore[arg-type]
            [lambda: gate_calls.append("verify") or 0],
            dry_run=False,
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "TAG_CONFLICT")
        self.assertEqual(gate_calls, [])
        self.assertEqual(git.writes, [])


class StewardPlanTests(unittest.TestCase):
    def test_plan_is_idempotent_and_keeps_protected_or_dirty_state(self) -> None:
        state = CleanupState(
            open_build_branches=frozenset({"build/v0.3.0"}),
            merged_remote_branches=(
                "build/v0.3.0",
                "capture/reference-evidence",
                "evidence/blind-review",
                "feat/merged",
                "origin",
            ),
            worktrees=(
                WorktreeState("/tmp/main", "main", True, False),
                WorktreeState("/tmp/build", "build/v0.3.0", True, False),
                WorktreeState("/tmp/dirty", "feat/merged", True, True),
                WorktreeState("/tmp/clean", "feat/merged", True, False),
            ),
        )
        first = plan_cleanup(state)
        second = plan_cleanup(state)
        self.assertEqual(first, second)
        self.assertIn("keep remote build/v0.3.0: open build line", first)
        self.assertIn("keep remote capture/reference-evidence: evidence branch", first)
        self.assertIn("keep remote evidence/blind-review: evidence branch", first)
        self.assertFalse(any("remote origin" in action for action in first))
        self.assertIn("keep worktree /tmp/main: main checkout", first)
        self.assertIn("keep worktree /tmp/dirty: uncommitted changes", first)
        self.assertIn("would delete remote feat/merged: merged into main", first)
        self.assertIn("would remove worktree /tmp/clean: merged into main", first)


class WorkflowContractTests(unittest.TestCase):
    def test_release_workflows_are_present_and_do_not_name_provider_secrets(self) -> None:
        paths = [
            ROOT / ".github/workflows/release-train.yml",
            ROOT / ".github/workflows/release.yml",
        ]
        text = "\n".join(path.read_text() for path in paths)
        self.assertIn("name: release-train", text)
        self.assertIn("scripts/release_steward.py verify-tag", text)
        for forbidden in (
            "OPENROUTER_API_KEY",
            "DASHSCOPE_API_KEY",
            "COMFYUI",
            "provider: auto",
        ):
            self.assertNotIn(forbidden, text)

    def test_main_ruleset_requires_release_train_and_only_owner_bypasses(self) -> None:
        request = json.loads(
            (ROOT / "docs/releases/v0.3.0/main-ruleset-request.json").read_text()
        )
        self.assertEqual(request["conditions"]["ref_name"]["include"], ["refs/heads/main"])
        self.assertEqual(
            request["bypass_actors"],
            [{"actor_id": 304586061, "actor_type": "User", "bypass_mode": "always"}],
        )
        rules = {rule["type"]: rule for rule in request["rules"]}
        self.assertIn("deletion", rules)
        self.assertIn("non_fast_forward", rules)
        self.assertIn("pull_request", rules)
        checks = rules["required_status_checks"]["parameters"]["required_status_checks"]
        self.assertEqual(checks, [{"context": "release-train"}])


if __name__ == "__main__":
    unittest.main()
