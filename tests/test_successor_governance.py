from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.validate_successor_governance import validate_repository


REPO_ROOT = Path(__file__).resolve().parents[1]


class SuccessorGovernanceTests(unittest.TestCase):
    def test_build_checkout_satisfies_the_successor_governance_contract(self) -> None:
        self.assertEqual(validate_repository(REPO_ROOT), [])

    def test_inherited_application_and_release_rules_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory) / "repository"
            for relative in (
                "AGENTS.md",
                "README.md",
                ".github/pull_request_template.md",
                ".github/workflows/verify.yml",
                ".sandcastle/sweep.json",
                "docs/agents/issue-tracker.md",
                "docs/agents/repository-workflow.md",
                "docs/agents/triage-labels.md",
                "scripts/verify.sh",
            ):
                source = REPO_ROOT / relative
                destination = candidate / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read_bytes())
            agents = candidate / "AGENTS.md"
            agents.write_text(
                agents.read_text(encoding="utf-8")
                + "\nThe standing integration line is release/v0.2.0.\n"
                + "The current milestone is the Godot Interactive Replica.\n",
                encoding="utf-8",
            )

            problems = validate_repository(candidate)

        self.assertIn("AGENTS.md contains inherited release/v0.2.0 governance", problems)
        self.assertIn("AGENTS.md contains inherited Godot application scope", problems)

    def test_commented_ffmpeg_contract_cannot_disguise_an_unpinned_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory) / "repository"
            for relative in (
                "AGENTS.md",
                "README.md",
                ".github/pull_request_template.md",
                ".github/workflows/verify.yml",
                ".sandcastle/sweep.json",
                "docs/agents/issue-tracker.md",
                "docs/agents/repository-workflow.md",
                "docs/agents/triage-labels.md",
                "scripts/verify.sh",
            ):
                source = REPO_ROOT / relative
                destination = candidate / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read_bytes())
            workflow = candidate / ".github/workflows/verify.yml"
            text = workflow.read_text(encoding="utf-8")
            text = text.replace(
                "    runs-on: ubuntu-24.04",
                "    runs-on: ubuntu-latest\n    # runs-on: ubuntu-24.04",
            ).replace(
                "          sudo apt-get install --yes --no-install-recommends ffmpeg",
                "          true\n          # sudo apt-get install --yes --no-install-recommends ffmpeg",
            )
            workflow.write_text(text, encoding="utf-8")

            problems = validate_repository(candidate)

        self.assertIn("Verify workflow does not pin the FFmpeg 6 runner image", problems)
        self.assertIn("Verify workflow does not install the FFmpeg 6 prerequisite", problems)

    def test_comments_cannot_disguise_missing_build_trigger_or_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory) / "repository"
            for relative in (
                "AGENTS.md",
                "README.md",
                ".github/pull_request_template.md",
                ".github/workflows/verify.yml",
                ".sandcastle/sweep.json",
                "docs/agents/issue-tracker.md",
                "docs/agents/repository-workflow.md",
                "docs/agents/triage-labels.md",
                "scripts/verify.sh",
            ):
                source = REPO_ROOT / relative
                destination = candidate / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read_bytes())
            workflow = candidate / ".github/workflows/verify.yml"
            text = workflow.read_text(encoding="utf-8")
            text = text.replace(
                '      - "build/**"',
                '      - "experimental/**"\n      # - "build/**"',
            ).replace(
                "        run: /usr/bin/env -i /bin/bash --noprofile --norc scripts/verify.sh",
                "        run: true\n        # run: /usr/bin/env -i /bin/bash --noprofile --norc scripts/verify.sh",
            )
            workflow.write_text(text, encoding="utf-8")

            problems = validate_repository(candidate)

        self.assertIn("Verify workflow does not run on build branches", problems)
        self.assertIn("Verify workflow does not call the canonical baseline", problems)

    def test_duplicate_active_runner_or_job_is_rejected(self) -> None:
        for suffix, mutation in (
            (
                "runner",
                lambda text: text.replace(
                    "    runs-on: ubuntu-24.04",
                    "    runs-on: ubuntu-24.04\n    runs-on: ubuntu-latest",
                ),
            ),
            (
                "job",
                lambda text: text + "\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
            ),
        ):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                candidate = Path(directory) / "repository"
                for relative in (
                    "AGENTS.md",
                    "README.md",
                    ".github/pull_request_template.md",
                    ".github/workflows/verify.yml",
                    ".sandcastle/sweep.json",
                    "docs/agents/issue-tracker.md",
                    "docs/agents/repository-workflow.md",
                    "docs/agents/triage-labels.md",
                    "scripts/verify.sh",
                ):
                    source = REPO_ROOT / relative
                    destination = candidate / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(source.read_bytes())
                workflow = candidate / ".github/workflows/verify.yml"
                workflow.write_text(mutation(workflow.read_text(encoding="utf-8")), encoding="utf-8")

                problems = validate_repository(candidate)

            self.assertTrue(problems, f"duplicate active {suffix} was accepted")


if __name__ == "__main__":
    unittest.main()
