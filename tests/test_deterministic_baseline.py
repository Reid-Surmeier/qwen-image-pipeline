from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.run_deterministic_command import (
    TRUSTED_NODE_MAJOR,
    _toolcache_node_candidates,
    _trusted_node,
    build_environment,
    validate_command,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


class DeterministicBaselineTests(unittest.TestCase):
    def test_node_resolution_cannot_drift_to_a_newer_toolcache_major(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            node22 = root / "22.23.0" / "x64" / "bin" / "node"
            node24 = root / "24.19.0" / "x64" / "bin" / "node"
            node22.parent.mkdir(parents=True)
            node24.parent.mkdir(parents=True)
            node22.touch()
            node24.touch()

            self.assertEqual(_toolcache_node_candidates(root), [node22])
        self.assertEqual(TRUSTED_NODE_MAJOR, 22)
        self.assertIn("v22.", subprocess.run(
            [_trusted_node(), "--version"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout)

    def test_only_the_documented_baseline_commands_are_allowed(self) -> None:
        validate_command(("@python", "-m", "unittest", "discover", "-s", "tests"))
        validate_command(("@git", "diff", "--check"))
        validate_command(("@node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"))
        validate_command(
            (
                "@node",
                "node_modules/dependency-cruiser/bin/dependency-cruise.mjs",
                "--config",
                ".dependency-cruiser.cjs",
                "modules",
            )
        )
        validate_command(
            ("@node", "scripts/run-control-tests.mjs")
        )
        validate_command(("@node", "scripts/vendored-check.mjs"))

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
        self.assertTrue(environment["PATH"].endswith(":/usr/bin:/bin"))
        self.assertEqual(environment["QWEN_BASELINE_PYTHON"], "/usr/bin/python3.12")
        self.assertEqual(Path(environment["QWEN_BASELINE_NODE"]).name, "node")
        self.assertEqual(environment["QWEN_BASELINE_GIT"], "/usr/bin/git")

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

    def test_python_and_node_children_cannot_send_udp(self) -> None:
        environment = build_environment(os.environ, REPO_ROOT)
        python = subprocess.run(
            [sys.executable, "tests/baseline_guard/probe_python_udp.py"],
            cwd=REPO_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        node = subprocess.run(
            ["node", "tests/baseline_guard/probe_node_udp.cjs"],
            cwd=REPO_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(python.returncode, 0)
        self.assertIn("network access is disabled", python.stderr)
        self.assertNotEqual(node.returncode, 0)
        self.assertIn("network access is disabled", node.stderr)

    def test_raw_network_syscall_is_denied_by_the_os(self) -> None:
        completed = subprocess.run(
            [sys.executable, "tests/baseline_guard/probe_python_raw_syscall.py"],
            cwd=REPO_ROOT,
            env=build_environment(os.environ, REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("raw network syscall is disabled", completed.stdout)

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

    def test_same_name_executable_substitution_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for kind in ("git", "node", "python"):
                fake = Path(directory) / kind
                fake.symlink_to("/bin/echo")
                completed = subprocess.run(
                    [
                        sys.executable,
                        "tests/baseline_guard/probe_python_substitution.py",
                        str(fake),
                        kind,
                    ],
                    cwd=REPO_ROOT,
                    env=build_environment(os.environ, REPO_ROOT),
                    capture_output=True,
                    text=True,
                    check=False,
                )

                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("substituted executable is disabled", completed.stdout)

    def test_approved_descendants_cannot_discard_the_guard_environment(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                "tests/baseline_guard/probe_python_stripped_environment.py",
            ],
            cwd=REPO_ROOT,
            env=build_environment(os.environ, REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("approved descendants preserve", completed.stdout)

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
