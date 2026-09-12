"""OpenRouter Image API request construction for Qwen Image 3."""

from __future__ import annotations

import json
import base64
import hashlib
import http.client
import math
import os
import socket
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from ..prompt_manifest import compile_edit_brief


DEFAULT_MODEL = "qwen/qwen-image-3-pro"
DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/images"
DEFAULT_TIMEOUT_SECONDS = 180


class _KeepAliveHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection that sends TCP keepalive probes while idle.

    An image edit can sit idle for minutes between the request and the
    first response byte. Without keepalives a NAT or proxy in the path can
    drop the idle mapping, and the finished (billed) response never reaches
    the client, which then waits out the whole read timeout. curl enables
    keepalives by default; urllib does not. Measured 2026-08-30: the same
    224 s request completed via curl and hung for 900 s via plain urllib.
    """

    def connect(self):
        super().connect()
        sock = self.sock
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        for name, value in (("TCP_KEEPIDLE", 30), ("TCP_KEEPINTVL", 15), ("TCP_KEEPCNT", 8)):
            option = getattr(socket, name, None)
            if option is not None:
                sock.setsockopt(socket.IPPROTO_TCP, option, value)


class _KeepAliveHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_KeepAliveHTTPSConnection, req, context=self._context)


def keepalive_urlopen(request, *, timeout):
    """urlopen equivalent whose HTTPS sockets send TCP keepalive probes."""
    return urllib.request.build_opener(_KeepAliveHTTPSHandler()).open(request, timeout=timeout)


def resolve_timeout_seconds() -> float:
    """``QWEN_OPENROUTER_TIMEOUT_SECONDS`` overrides the client's default.

    Unset, unparseable, non-positive or infinite values keep the default, so the
    override can never disable the timeout.

    This lives here, beside the default it overrides, because both entry points need
    it. The ComfyUI node had it and the CLI did not, and the CLI is the path the icon
    batches use: every call took the hard 180 s default, every generation slower than
    that timed out client-side, and OpenRouter billed the finished image anyway.
    Measured 2026-08-30 — $3.36 billed for images that were never delivered.
    """
    raw = os.environ.get("QWEN_OPENROUTER_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return float(DEFAULT_TIMEOUT_SECONDS)
    try:
        value = float(raw)
    except ValueError:
        return float(DEFAULT_TIMEOUT_SECONDS)
    if value <= 0 or not math.isfinite(value):
        return float(DEFAULT_TIMEOUT_SECONDS)
    return value


class OpenRouterImageClient:
    """Small synchronous client for the dedicated OpenRouter Image API."""

    def __init__(
        self,
        api_key: str,
        *,
        endpoint: str = DEFAULT_ENDPOINT,
        opener: Callable[..., Any] = keepalive_urlopen,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        if not api_key:
            raise ValueError("OpenRouter API key is required")
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise ValueError("timeout must be a finite positive number of seconds")
        self._api_key = api_key
        self._endpoint = endpoint
        self._opener = opener
        self._timeout = timeout

    def generate(self, request_body: Mapping[str, Any]) -> dict[str, Any]:
        if request_body.get("model") != "meta/muse-image":
            raise ValueError("Qwen image generation is retired; use the saved Muse procedure through image-pipeline")
        body = json.dumps(dict(request_body)).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "User-Agent": "qwen-ui-pipeline/0.1",
            },
        )
        try:
            with self._opener(request, timeout=self._timeout) as response:
                payload = json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                error_payload = json.loads(error.read(8192))
                error_value = error_payload.get("error", error_payload)
                if isinstance(error_value, dict):
                    detail = str(error_value.get("message", "")).strip()
                elif isinstance(error_value, str):
                    detail = error_value.strip()
            except (AttributeError, UnicodeDecodeError, json.JSONDecodeError):
                pass
            suffix = f": {detail}" if detail else ""
            raise RuntimeError(
                f"OpenRouter Image API returned HTTP {error.code}{suffix}"
            ) from error
        if not isinstance(payload, dict):
            raise RuntimeError("OpenRouter Image API returned a non-object response")
        return payload


def build_openrouter_request(
    brief: Mapping[str, Any],
    *,
    reference_urls: Sequence[str] = (),
) -> dict[str, Any]:
    """Translate an Edit Brief into the supported OpenRouter Image API shape."""

    if len(reference_urls) > 4:
        raise ValueError("Qwen Image 3 accepts at most 4 reference images")
    compiled = compile_edit_brief(brief)
    output = brief.get("output", {})
    request: dict[str, Any] = {
        "model": str(brief.get("model", DEFAULT_MODEL)),
        "prompt": compiled.prompt,
        "resolution": str(output.get("resolution", "2K")),
        "aspect_ratio": str(output.get("aspect_ratio", "16:9")),
        "n": int(output.get("count", 1)),
    }
    if "seed" in output:
        request["seed"] = int(output["seed"])
    if reference_urls:
        request["input_references"] = [
            {"type": "image_url", "image_url": {"url": url}}
            for url in reference_urls
        ]
    return request


def _extension(media_type: str) -> str:
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
    }.get(media_type, ".bin")


def _sanitized_request(request_body: Mapping[str, Any]) -> dict[str, Any]:
    def redact_embedded_images(value: Any) -> Any:
        if isinstance(value, dict):
            redacted: dict[str, Any] = {}
            for key, item in value.items():
                if (
                    key in {"image", "image_url", "url"}
                    and isinstance(item, str)
                    and item.startswith("data:image/")
                ):
                    redacted[key] = "[recorded separately]"
                else:
                    redacted[key] = redact_embedded_images(item)
            return redacted
        if isinstance(value, list):
            return [redact_embedded_images(item) for item in value]
        return value

    sanitized = redact_embedded_images(dict(request_body))
    references = sanitized.get("input_references")
    if isinstance(references, list):
        sanitized["input_references"] = [
            {"type": item.get("type", "image_url"), "image_url": "[recorded separately]"}
            if isinstance(item, dict)
            else "[recorded separately]"
            for item in references
        ]
    return sanitized


def _request_prompt(request_body: Mapping[str, Any]) -> str:
    prompt = request_body.get("prompt")
    if isinstance(prompt, str):
        return prompt
    input_value = request_body.get("input")
    if not isinstance(input_value, dict):
        return ""
    messages = input_value.get("messages")
    if not isinstance(messages, list):
        return ""
    text_blocks = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        text_blocks.extend(
            item["text"]
            for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        )
    return "\n\n".join(text_blocks)


def write_run_artifacts(
    output_directory: Path,
    brief: Mapping[str, Any],
    request_body: Mapping[str, Any],
    response_body: Mapping[str, Any],
    *,
    provenance: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Persist a Render Pass while keeping base64 payloads out of metadata."""

    output_directory.mkdir(parents=True, exist_ok=True)
    images = response_body.get("data", [])
    outputs = []
    sanitized_images = []
    for index, item in enumerate(images, start=1):
        if not isinstance(item, dict) or not isinstance(item.get("b64_json"), str):
            continue
        media_type = str(item.get("media_type", "application/octet-stream"))
        image_bytes = base64.b64decode(item["b64_json"], validate=True)
        filename = f"image-{index:02d}{_extension(media_type)}"
        (output_directory / filename).write_bytes(image_bytes)
        digest = hashlib.sha256(image_bytes).hexdigest()
        outputs.append(
            {
                "file": filename,
                "media_type": media_type,
                "bytes": len(image_bytes),
                "sha256": digest,
            }
        )
        sanitized_images.append(
            {"media_type": media_type, "bytes": len(image_bytes), "sha256": digest}
        )

    record = {
        "outputs": outputs,
        "usage": response_body.get("usage", {}),
        "provenance": dict(provenance or {}),
    }
    response_metadata = dict(response_body)
    response_metadata["data"] = sanitized_images
    files = {
        "brief.json": brief,
        "request.json": _sanitized_request(request_body),
        "response.json": response_metadata,
        "run.json": record,
    }
    for filename, value in files.items():
        (output_directory / filename).write_text(
            json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    (output_directory / "prompt.txt").write_text(
        _request_prompt(request_body) + "\n", encoding="utf-8"
    )
    return record
