from __future__ import annotations

import os
import socket


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

    socket.socket = _OfflineSocket
    socket.create_connection = _blocked
