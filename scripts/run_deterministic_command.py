from __future__ import annotations

import os
import hashlib
import subprocess
import sys
import tempfile
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

TRUSTED_PYTHON = Path("/usr/bin/python3.12")
TRUSTED_NODE = Path("/usr/bin/node")
TRUSTED_GIT = Path("/usr/bin/git")
TRUSTED_COMPILER = Path("/usr/bin/cc")
TRUSTED_PATH = "/usr/bin:/bin"

SAFE_CHILD_SCRIPTS = (
    "scripts/visual_gate.py",
    "scripts/audit_project_skills.py",
    "scripts/compute_skill_folder_hash.mjs",
    "tests/baseline_guard/probe_python_network.py",
    "tests/baseline_guard/probe_python_udp.py",
    "tests/baseline_guard/probe_python_descendant.py",
    "tests/baseline_guard/probe_python_substitution.py",
    "tests/baseline_guard/probe_python_stripped_environment.py",
    "tests/baseline_guard/probe_python_model.py",
    "tests/baseline_guard/probe_node_network.cjs",
    "tests/baseline_guard/probe_node_udp.cjs",
    "tests/baseline_guard/probe_node_descendant.cjs",
)


def validate_command(command: Sequence[str]) -> None:
    if not command:
        raise ValueError("missing deterministic baseline command")
    executable_path = Path(command[0]).resolve()
    executable = Path(command[0]).name
    arguments = tuple(command[1:])
    is_current_python = executable_path == TRUSTED_PYTHON.resolve()
    is_selected_node = executable_path == TRUSTED_NODE.resolve()
    is_selected_git = executable_path == TRUSTED_GIT.resolve()
    allowed = (
        (is_current_python, arguments in PYTHON_COMMANDS),
        (is_selected_node, arguments in NODE_COMMANDS),
        (is_selected_git, arguments in GIT_COMMANDS),
    )
    if not any(
        matches_executable and matches_arguments
        for matches_executable, matches_arguments in allowed
    ):
        raise ValueError(f"command is not part of the deterministic baseline: {executable}")


def _native_guard(repository: Path) -> Path:
    source = repository / "tests" / "baseline_guard" / "no_external_effects.c"
    source_bytes = source.read_bytes()
    digest = hashlib.sha256(source_bytes).hexdigest()[:16]
    guard_directory = Path(tempfile.gettempdir()) / "qwen-image-pipeline-baseline"
    guard_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    output = guard_directory / f"no_external_effects-{digest}.so"
    if output.is_file():
        return output
    if not TRUSTED_COMPILER.is_file():
        raise RuntimeError(
            "the deterministic baseline requires a C compiler for process isolation"
        )
    temporary = output.with_suffix(f".{os.getpid()}.tmp")
    completed = subprocess.run(
        [
            TRUSTED_COMPILER,
            "-shared",
            "-fPIC",
            "-O2",
            "-o",
            temporary,
            source,
            "-ldl",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            completed.stderr.strip() or "failed to compile baseline process guard"
        )
    os.replace(temporary, output)
    return output


def build_environment(source: Mapping[str, str], repository: Path) -> dict[str, str]:
    environment = {
        name: source[name]
        for name in SAFE_ENVIRONMENT_NAMES
        if name in source
    }
    guard_directory = repository / "tests" / "baseline_guard"
    for executable in (TRUSTED_PYTHON, TRUSTED_NODE, TRUSTED_GIT):
        if not executable.is_file():
            raise RuntimeError(f"missing deterministic baseline tool: {executable}")
    environment.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "LD_PRELOAD": str(_native_guard(repository)),
            "NODE_OPTIONS": f"--require={guard_directory / 'no_external_effects.cjs'}",
            "PYTHONPATH": str(guard_directory),
            "PYTHONUTF8": "1",
            "QWEN_BASELINE_OFFLINE": "1",
            "QWEN_BASELINE_REPOSITORY": str(repository.resolve()),
            "QWEN_BASELINE_PYTHON": str(TRUSTED_PYTHON.resolve()),
            "QWEN_BASELINE_NODE": str(TRUSTED_NODE.resolve()),
            "QWEN_BASELINE_GIT": str(TRUSTED_GIT.resolve()),
            "PATH": TRUSTED_PATH,
            "QWEN_BASELINE_ALLOWED_SCRIPTS": os.pathsep.join(
                str((repository / relative).resolve())
                for relative in SAFE_CHILD_SCRIPTS
            ),
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
