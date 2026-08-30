from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

from scripts.run_deterministic_command import build_environment, validate_command


REPO_ROOT = Path(__file__).resolve().parents[1]


class DeterministicBaselineTests(unittest.TestCase):
    def test_only_the_documented_baseline_commands_are_allowed(self) -> None:
        validate_command((sys.executable, "-m", "unittest", "discover", "-s", "tests"))
        validate_command(("git", "diff", "--check"))

        with self.assertRaisesRegex(ValueError, "not part of the deterministic baseline"):
            validate_command(("curl", "https://openrouter.ai"))

    def test_child_environment_excludes_credentials_and_loads_offline_guards(self) -> None:
        environment = build_environment(
            {
                "PATH": os.environ["PATH"],
                "LANG": "C.UTF-8",
                "OPENROUTER_API_KEY": "must-not-cross-the-seam",
                "BWS_ACCESS_TOKEN": "must-not-cross-the-seam",
            },
            REPO_ROOT,
        )

        self.assertNotIn("OPENROUTER_API_KEY", environment)
        self.assertNotIn("BWS_ACCESS_TOKEN", environment)
        self.assertEqual(environment["QWEN_BASELINE_OFFLINE"], "1")
        self.assertIn("baseline_guard", environment["PYTHONPATH"])
        self.assertIn("no_external_effects.cjs", environment["NODE_OPTIONS"])
        self.assertIn("no_external_effects-", environment["LD_PRELOAD"])

    def test_python_named_provider_is_not_accepted_as_the_interpreter(self) -> None:
        with self.assertRaisesRegex(ValueError, "not part of the deterministic baseline"):
            validate_command(
                ("/tmp/python-provider", "-m", "unittest", "discover", "-s", "tests")
            )

    def test_python_child_cannot_open_a_network_connection(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                "tests/baseline_guard/probe_python_network.py",
            ],
            cwd=REPO_ROOT,
            env=build_environment(os.environ, REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("network access is disabled in the deterministic baseline", completed.stderr)

    def test_python_child_cannot_spawn_an_unlisted_descendant(self) -> None:
        completed = subprocess.run(
            [sys.executable, "tests/baseline_guard/probe_python_descendant.py"],
            cwd=REPO_ROOT,
            env=build_environment(os.environ, REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("descendant process is disabled", completed.stdout)

    def test_python_child_cannot_load_a_model_runtime(self) -> None:
        completed = subprocess.run(
            [sys.executable, "tests/baseline_guard/probe_python_model.py"],
            cwd=REPO_ROOT,
            env=build_environment(os.environ, REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("model inference is disabled", completed.stdout)

    def test_node_child_cannot_open_network_or_spawn_a_descendant(self) -> None:
        environment = build_environment(os.environ, REPO_ROOT)
        network = subprocess.run(
            ["node", "tests/baseline_guard/probe_node_network.cjs"],
            cwd=REPO_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        descendant = subprocess.run(
            ["node", "tests/baseline_guard/probe_node_descendant.cjs"],
            cwd=REPO_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(network.returncode, 0)
        self.assertIn("network access is disabled", network.stderr)
        self.assertEqual(descendant.returncode, 0, descendant.stderr)
        self.assertIn("descendant process is disabled", descendant.stdout)


if __name__ == "__main__":
    unittest.main()
