from __future__ import annotations

import importlib.abc
import inspect
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path


if os.environ.get("QWEN_BASELINE_OFFLINE") == "1":
    _socket_type = socket.socket

    def _blocked(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("network access is disabled in the deterministic baseline")

    class _OfflineSocket(_socket_type):
        def connect(self, *_args: object, **_kwargs: object) -> None:
            _blocked()

        def connect_ex(self, *_args: object, **_kwargs: object) -> int:
            _blocked()
            return 1

        def sendto(self, *_args: object, **_kwargs: object) -> int:
            _blocked()
            return 0

        def sendmsg(self, *_args: object, **_kwargs: object) -> int:
            _blocked()
            return 0

    socket.socket = _OfflineSocket
    socket.create_connection = _blocked

    _repository = Path(os.environ["QWEN_BASELINE_REPOSITORY"]).resolve()
    _approved_scripts = {
        Path(value).resolve()
        for value in os.environ["QWEN_BASELINE_ALLOWED_SCRIPTS"].split(os.pathsep)
    }
    _pinned_executables = {
        "python": Path(os.environ["QWEN_BASELINE_PYTHON"]).resolve(),
        "node": Path(os.environ["QWEN_BASELINE_NODE"]).resolve(),
        "git": Path(os.environ["QWEN_BASELINE_GIT"]).resolve(),
    }

    def _approved_git(arguments: list[object] | tuple[object, ...]) -> bool:
        if len(arguments) < 5 or tuple(map(os.fspath, arguments[1:3])) != (
            "-C",
            str(_repository),
        ):
            return False
        command = os.fspath(arguments[3])
        values = tuple(map(os.fspath, arguments[4:]))
        if command == "cat-file":
            return (
                len(values) == 2
                and values[0] == "-e"
                and values[1].endswith("^{commit}")
            )
        if command == "show-ref":
            return (
                len(values) == 2
                and values[0] == "--verify"
                and values[1].startswith("refs/remotes/origin/")
            )
        if command == "rev-parse":
            return len(values) == 1
        if command == "show":
            return len(values) == 1 and ":" in values[0]
        return False

    def _approved_child(arguments: object, shell: bool) -> bool:
        if shell or not isinstance(arguments, (list, tuple)) or len(arguments) < 2:
            return False
        executable = shutil.which(os.fspath(arguments[0]))
        if executable is None:
            return False
        executable_path = Path(executable).resolve()
        script = Path(os.fspath(arguments[1])).resolve()
        if executable_path == _pinned_executables["python"]:
            return script in _approved_scripts
        if executable_path == _pinned_executables["node"]:
            return (
                script in _approved_scripts
                or tuple(map(os.fspath, arguments[1:])) == ("--version",)
            )
        if executable_path == _pinned_executables["git"]:
            return _approved_git(arguments)
        return False

    _original_popen = subprocess.Popen
    _popen_signature = inspect.signature(_original_popen)
    _guard_environment = dict(os.environ)

    class _OfflinePopen(_original_popen):
        def __init__(self, args: object, *popen_args: object, **popen_kwargs: object) -> None:
            bound = _popen_signature.bind_partial(args, *popen_args, **popen_kwargs)
            if not _approved_child(args, bool(bound.arguments.get("shell", False))):
                raise PermissionError("descendant process is disabled in the deterministic baseline")
            bound.arguments["env"] = dict(_guard_environment)
            super().__init__(*bound.args, **bound.kwargs)

    subprocess.Popen = _OfflinePopen

    class _BlockedModelFinder(importlib.abc.MetaPathFinder):
        _blocked_roots = {
            "comfy",
            "diffusers",
            "onnxruntime",
            "openai",
            "tensorflow",
            "torch",
            "transformers",
        }

        def find_spec(
            self,
            fullname: str,
            path: object = None,
            target: object = None,
        ) -> None:
            if fullname.partition(".")[0] in self._blocked_roots:
                raise ImportError(
                    "model inference is disabled in the deterministic baseline"
                )
            return None

    sys.meta_path.insert(0, _BlockedModelFinder())

    def _blocked_child(*_args: object, **_kwargs: object) -> None:
        raise PermissionError("descendant process is disabled in the deterministic baseline")

    os.system = _blocked_child
    for _name in (
        "execl",
        "execle",
        "execlp",
        "execlpe",
        "execv",
        "execve",
        "execvp",
        "execvpe",
        "spawnl",
        "spawnle",
        "spawnlp",
        "spawnlpe",
        "spawnv",
        "spawnve",
        "spawnvp",
        "spawnvpe",
    ):
        if hasattr(os, _name):
            setattr(os, _name, _blocked_child)
