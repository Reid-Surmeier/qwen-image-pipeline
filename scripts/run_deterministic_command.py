from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Mapping, Sequence


SAFE_ENVIRONMENT_NAMES = (
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
)

PYTHON_COMMANDS = {
    ("scripts/validate_successor_governance.py",),
    ("-m", "unittest", "discover", "-s", "tests"),
    ("-m", "compileall", "-q", "qwen_ui_pipeline", "tests", "scripts"),
}
NODE_COMMANDS = {
    (
        "--test",
        "tests/figma-mcp-client.test.mjs",
        "tests/figma-oauth-bootstrap.test.mjs",
    ),
}
GIT_COMMANDS = {("diff", "--check")}


def validate_command(command: Sequence[str]) -> None:
    if not command:
        raise ValueError("missing deterministic baseline command")
    executable = Path(command[0]).name
    arguments = tuple(command[1:])
    allowed = (
        (executable.startswith("python"), arguments in PYTHON_COMMANDS),
        (executable == "node", arguments in NODE_COMMANDS),
        (executable == "git", arguments in GIT_COMMANDS),
    )
    if not any(matches_executable and matches_arguments for matches_executable, matches_arguments in allowed):
        raise ValueError(f"command is not part of the deterministic baseline: {executable}")


def build_environment(source: Mapping[str, str], repository: Path) -> dict[str, str]:
    environment = {
        name: source[name]
        for name in SAFE_ENVIRONMENT_NAMES
        if name in source
    }
    guard_directory = repository / "tests" / "baseline_guard"
    environment.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "NODE_OPTIONS": f"--require={guard_directory / 'no_external_effects.cjs'}",
            "PYTHONPATH": str(guard_directory),
            "PYTHONUTF8": "1",
            "QWEN_BASELINE_OFFLINE": "1",
        }
    )
    return environment


def main(arguments: Sequence[str] | None = None) -> int:
    arguments = tuple(sys.argv[1:] if arguments is None else arguments)
    if not arguments or arguments[0] != "--":
        print("usage: run_deterministic_command.py -- COMMAND [ARG ...]", file=sys.stderr)
        return 2
    command = arguments[1:]
    try:
        validate_command(command)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    repository = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        command,
        cwd=repository,
        env=build_environment(os.environ, repository),
        check=False,
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
