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
    ("scripts/generate_module_map.py", "--check"),
    ("-m", "unittest", "discover", "-s", "tests"),
    ("-m", "compileall", "-q", "qwen_ui_pipeline", "tests", "scripts"),
}
NODE_COMMANDS = {
    (
        "--test",
        "tests/figma-mcp-client.test.mjs",
        "tests/figma-oauth-bootstrap.test.mjs",
    ),
    ("node_modules/typescript/bin/tsc", "-p", "tsconfig.json"),
    (
        "node_modules/dependency-cruiser/bin/dependency-cruise.mjs",
        "--config",
        ".dependency-cruiser.cjs",
        "modules",
    ),
    ("scripts/run-control-tests.mjs",),
    ("scripts/vendored-check.mjs",),
}
GIT_COMMANDS = {("diff", "--check")}

TRUSTED_PYTHON = Path("/usr/bin/python3.12")
TRUSTED_GIT = Path("/usr/bin/git")
TRUSTED_COMPILER = Path("/usr/bin/cc")
TRUSTED_FFMPEG = Path("/usr/bin/ffmpeg")
TRUSTED_FFMPEG_MAJOR = 6
TRUSTED_NODE_MAJOR = 22

SAFE_CHILD_SCRIPTS = (
    "scripts/visual_gate.py",
    "scripts/audit_project_skills.py",
    "scripts/compute_skill_folder_hash.mjs",
    "tests/baseline_guard/probe_python_network.py",
    "tests/baseline_guard/probe_python_udp.py",
    "tests/baseline_guard/probe_python_descendant.py",
    "tests/baseline_guard/probe_python_substitution.py",
    "tests/baseline_guard/probe_python_stripped_environment.py",
    "tests/baseline_guard/probe_python_raw_syscall.py",
    "tests/baseline_guard/probe_python_model.py",
    "tests/baseline_guard/probe_node_network.cjs",
    "tests/baseline_guard/probe_node_udp.cjs",
    "tests/baseline_guard/probe_node_descendant.cjs",
    "tests/baseline_guard/probe_node_ffmpeg.cjs",
)


def validate_command(command: Sequence[str]) -> None:
    if not command:
        raise ValueError("missing deterministic baseline command")
    executable = Path(command[0]).name
    arguments = tuple(command[1:])
    allowed = (
        (command[0] == "@python", arguments in PYTHON_COMMANDS),
        (command[0] == "@node", arguments in NODE_COMMANDS),
        (command[0] == "@git", arguments in GIT_COMMANDS),
    )
    if not any(
        matches_executable and matches_arguments
        for matches_executable, matches_arguments in allowed
    ):
        raise ValueError(f"command is not part of the deterministic baseline: {executable}")


def _toolcache_node_candidates(root: Path = Path("/opt/hostedtoolcache/node")) -> list[Path]:
    return sorted(
        root.glob(f"{TRUSTED_NODE_MAJOR}.*/x64/bin/node"),
        reverse=True,
    )


def _node_major(candidate: Path) -> int | None:
    completed = subprocess.run(
        [candidate, "--version"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    major = completed.stdout.strip().removeprefix("v").split(".", 1)[0]
    return int(major) if major.isdigit() else None


def _trusted_node() -> Path:
    candidates = [Path("/usr/bin/node")]
    candidates.extend(_toolcache_node_candidates())
    for candidate in candidates:
        if (
            candidate.is_file()
            and os.access(candidate, os.X_OK)
            and _node_major(candidate) == TRUSTED_NODE_MAJOR
        ):
            return candidate.resolve()
    raise RuntimeError(
        f"missing deterministic baseline tool: Node {TRUSTED_NODE_MAJOR}"
    )


def _trusted_ffmpeg() -> Path:
    if not TRUSTED_FFMPEG.is_file() or not os.access(TRUSTED_FFMPEG, os.X_OK):
        raise RuntimeError(f"missing deterministic baseline tool: {TRUSTED_FFMPEG}")
    if os.environ.get("QWEN_BASELINE_OFFLINE") == "1":
        inherited = os.environ.get("QWEN_BASELINE_FFMPEG")
        if inherited is None or Path(inherited).resolve() != TRUSTED_FFMPEG.resolve():
            raise RuntimeError("deterministic baseline FFmpeg identity changed inside the guard")
        return TRUSTED_FFMPEG.resolve()
    completed = subprocess.run(
        [TRUSTED_FFMPEG, "-version"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    first_line = completed.stdout.splitlines()[0] if completed.stdout else ""
    version = first_line.removeprefix("ffmpeg version ").split(".", 1)[0]
    if completed.returncode != 0 or version != str(TRUSTED_FFMPEG_MAJOR):
        raise RuntimeError(
            f"missing deterministic baseline tool: FFmpeg {TRUSTED_FFMPEG_MAJOR}"
        )
    return TRUSTED_FFMPEG.resolve()


def _resolve_command(command: Sequence[str]) -> tuple[str, ...]:
    executables = {
        "@python": TRUSTED_PYTHON.resolve(),
        "@node": _trusted_node(),
        "@git": TRUSTED_GIT.resolve(),
    }
    return (str(executables[command[0]]), *command[1:])


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
    node = _trusted_node()
    for executable in (TRUSTED_PYTHON, TRUSTED_GIT):
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
            "QWEN_BASELINE_NODE": str(node),
            "QWEN_BASELINE_GIT": str(TRUSTED_GIT.resolve()),
            "QWEN_BASELINE_FFMPEG": str(_trusted_ffmpeg()),
            "PATH": f"{node.parent}:/usr/bin:/bin",
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
        _resolve_command(command),
        cwd=repository,
        env=build_environment(os.environ, repository),
        check=False,
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
