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


if __name__ == "__main__":
    unittest.main()
