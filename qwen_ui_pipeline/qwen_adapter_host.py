"""Stdio host for the versioned Qwen kernel adapter."""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from .providers.openrouter import OpenRouterImageClient, resolve_timeout_seconds
from .muse_adapter import invoke_muse_kernel, recover_muse_kernel
from .qwen_adapter import QwenKernelError, invoke_qwen_kernel


def execute(document: Any, *, client: Any) -> dict[str, Any]:
    """Execute one decoded adapter document with an injected client."""

    if isinstance(document, dict) and document.get("operation") == "recover":
        return recover_muse_kernel(document)
    return (invoke_muse_kernel if isinstance(document, dict) and document.get("model") == "meta/muse-image" else invoke_qwen_kernel)(document, client=client)


def _safe_error(error: QwenKernelError) -> dict[str, Any]:
    return {"adapter_error": {"code": error.code, "message": str(error)}}


def main() -> int:
    try:
        document = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        print(json.dumps(_safe_error(QwenKernelError("ADAPTER_NOT_STARTED", "Adapter input is not JSON."))))
        return 2

    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    recovery = isinstance(document, dict) and document.get("operation") == "recover"
    if not api_key and not recovery:
        print(json.dumps(_safe_error(QwenKernelError("ADAPTER_NOT_STARTED", "The logical OpenRouter credential is unavailable."))))
        return 2
    try:
        client = None if recovery else OpenRouterImageClient(api_key, timeout=600 if isinstance(document, dict) and document.get("model") == "meta/muse-image" else resolve_timeout_seconds())
    except Exception:
        print(json.dumps(_safe_error(QwenKernelError("ADAPTER_NOT_STARTED", "The OpenRouter client could not be initialized."))))
        return 2
    try:
        result = execute(document, client=client)
    except QwenKernelError as error:
        print(json.dumps(_safe_error(error), sort_keys=True, separators=(",", ":")))
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
