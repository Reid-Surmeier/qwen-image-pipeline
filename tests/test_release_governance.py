from __future__ import annotations

import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts.release_steward import (
    CleanupState,
    ReleaseEvidence,
    WorktreeState,
    cut_release,
    evidence_from_repo,
    evaluate_release,
    main,
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

    def test_one_direct_evidence_only_commit_is_still_stale(self) -> None:
        decision = evaluate_release(
            evidence(
                target_sha=SHA_B,
                remote_tip_sha=SHA_B,
                review_text=f"reviewed: {SHA_A}\nverdict: ship\n",
            )
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "STALE_REVIEW")

    def test_a_different_version_cannot_be_cut_from_the_line(self) -> None:
        decision = evaluate_release(evidence(version="0.4.0"))
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "WRONG_BUILD_BRANCH")

    def test_malformed_version_cannot_create_a_lookalike_build_line(self) -> None:
        decision = evaluate_release(
            evidence(version="0x.3y.0z", branch="build/v0x.3y.0z")
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "INVALID_VERSION")

    def test_lightweight_tag_candidate_is_not_a_release(self) -> None:
        decision = evaluate_release(evidence(tag_is_annotated=False))
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "UNANNOTATED_TAG")


class FakeGit:
    def __init__(
        self,
        *,
        local: str | None = None,
        remote: str | None = None,
        local_kind: str | None = None,
        remote_annotated: bool | None = None,
    ) -> None:
        self.local = local
        self.remote = remote
        self.local_kind = local_kind
        self.remote_annotated = remote_annotated
        self.writes: list[tuple[str, ...]] = []

    def local_tag_target(self, _tag: str) -> str | None:
        return self.local

    def remote_tag_target(self, _tag: str) -> str | None:
        return self.remote

    def local_tag_kind(self, _tag: str) -> str | None:
        return self.local_kind

    def remote_tag_is_annotated(self, _tag: str) -> bool | None:
        return self.remote_annotated

    def create_tag(self, tag: str, target: str, message: str) -> None:
        self.writes.append(("tag", tag, target, message))
        self.local = target
        self.local_kind = "tag"

    def push_tag(self, tag: str) -> None:
        self.writes.append(("push-tag", tag))
        self.remote = self.local
        self.remote_annotated = self.local_kind == "tag"


class ReleaseCutTests(unittest.TestCase):
    def test_verify_tag_reads_exact_review_back_from_annotation(self) -> None:
        class TagGit:
            def sha(self, _ref: str) -> str:
                return SHA_A

            def clean(self) -> bool:
                return True

            def local_tag_kind(self, _tag: str) -> str:
                return "tag"

            def tag_message(self, _tag: str) -> str:
                return f"A dependable procedure.\n\nreviewed: {SHA_A}\nverdict: ship\n"

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "docs/releases/v0.3.0"
            folder.mkdir(parents=True)
            (folder / "RELEASE.md").write_text("# v0.3.0\n\nA dependable procedure.\n")
            candidate = evidence_from_repo(
                root,
                TagGit(),  # type: ignore[arg-type]
                "0.3.0",
                tag_checkout=True,
            )
        decision = evaluate_release(candidate)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.target_sha, SHA_A)

    def test_malformed_cli_version_is_refused_before_repository_evidence_paths(self) -> None:
        with patch("scripts.release_steward.evidence_from_repo") as read_evidence:
            self.assertEqual(
                main(["cut", "../../bad", "--repo", str(ROOT), "--dry-run"]),
                1,
            )
        read_evidence.assert_not_called()

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
        self.assertIn(f"reviewed: {SHA_A}", git.writes[0][3])
        self.assertIn("verdict: ship", git.writes[0][3])

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

    def test_matching_lightweight_tags_are_refused_before_the_gate(self) -> None:
        for git in (
            FakeGit(local=SHA_A, local_kind="commit"),
            FakeGit(remote=SHA_A, remote_annotated=False),
        ):
            with self.subTest(git=git):
                gate_calls: list[str] = []
                decision = cut_release(
                    evidence(),
                    git,  # type: ignore[arg-type]
                    [lambda: gate_calls.append("verify") or 0],
                    dry_run=False,
                )
                self.assertFalse(decision.allowed)
                self.assertEqual(decision.code, "UNANNOTATED_TAG")
                self.assertEqual(gate_calls, [])
                self.assertEqual(git.writes, [])


class StewardPlanTests(unittest.TestCase):
    def test_cli_dry_run_never_fetches_or_updates_refs(self) -> None:
        empty = CleanupState(frozenset(), (), ())
        with (
            patch("scripts.release_steward.Git.fetch", create=True, side_effect=AssertionError("fetch wrote refs")),
            patch("scripts.release_steward.observe_cleanup", return_value=empty),
        ):
            self.assertEqual(main(["--repo", str(ROOT), "--dry-run"]), 0)

    def test_plan_is_idempotent_and_keeps_protected_or_dirty_state(self) -> None:
        state = CleanupState(
            open_build_branches=frozenset({"build/v0.3.0"}),
            active_evidence_branches=frozenset({"experiment/manual-proof", "feat/merged"}),
            merged_remote_branches=(
                "build/v0.3.0",
                "capture/reference-evidence",
                "evidence/blind-review",
                "feat/merged",
                "experiment/manual-proof",
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
        self.assertIn("keep remote experiment/manual-proof: active evidence", first)
        self.assertFalse(any("remote origin" in action for action in first))
        self.assertIn("keep worktree /tmp/main: main checkout", first)
        self.assertIn("keep worktree /tmp/dirty: uncommitted changes", first)
        self.assertIn("keep remote feat/merged: active evidence", first)
        self.assertIn("keep worktree /tmp/clean: active evidence", first)


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

    def test_required_release_train_exists_only_for_a_reviewed_version_tag(self) -> None:
        train = (ROOT / ".github/workflows/release-train.yml").read_text()
        release = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertIn('tags: ["v*"]', train)
        self.assertNotIn("pull_request:", train)
        self.assertIn('scripts/release_steward.py verify-tag "$GITHUB_REF_NAME"', train)
        self.assertNotIn("build/v[0-9]*", train)
        self.assertIn('--match-head-commit "$tag_sha"', release)

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
