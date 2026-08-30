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

    def test_python_child_cannot_open_a_network_connection(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                "import socket; socket.create_connection(('example.com', 443))",
            ],
            cwd=REPO_ROOT,
            env=build_environment(os.environ, REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("network access is disabled in the deterministic baseline", completed.stderr)


if __name__ == "__main__":
    unittest.main()
