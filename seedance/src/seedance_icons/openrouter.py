from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

API_BASE = "https://openrouter.ai/api/v1"
MAX_ERROR_BODY_BYTES = 64 * 1024
SAFE_ERROR_RESPONSE_HEADERS = frozenset(
    {
        "content-type",
        "retry-after",
        "x-generation-id",
        "x-openrouter-request-id",
        "x-request-id",
    }
)
SENSITIVE_FIELD_NAMES = frozenset(
    {
        "access_token",
        "accesstoken",
        "api_key",
        "apikey",
        "authorization",
        "client_secret",
        "clientsecret",
        "cookie",
        "credential",
        "credentials",
        "password",
        "refresh_token",
        "refreshtoken",
        "secret",
        "set_cookie",
        "setcookie",
        "token",
    }
)
AUTHORIZATION_VALUE = re.compile(
    r"(?i)(\bauthorization[\"']?\s*[:=]\s*[\"']?)(?:bearer|basic)\s+[^\s\"'\\,;}\]]+"
)
BEARER_VALUE = re.compile(
    r"(?i)(\bbearer\s+)([^\s\"'\\,;}\]]+)"
)
OPENROUTER_KEY_VALUE = re.compile(r"\bsk-or-v1-[A-Za-z0-9._~-]+")
URL_PASSWORD_VALUE = re.compile(r"(?i)(https?://[^:/\s]+:)([^@\s/]+)(@)")
SENSITIVE_ASSIGNMENT_VALUE = re.compile(
    r"(?i)(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|"
    r"client[_-]?secret|secret|cookie|set-cookie|credentials?)\b[\"']?\s*[:=]\s*[\"']?)"
    r"([^\s\"'\\,;}\]]+)"
)
TRUNCATION_MARKER = "\n<TRUNCATED>"


class OpenRouterError(RuntimeError):
    pass


def _redact_sensitive_text(value: str) -> str:
    value = AUTHORIZATION_VALUE.sub(r"\1<REDACTED>", value)
    value = BEARER_VALUE.sub(r"\1<REDACTED>", value)
    value = OPENROUTER_KEY_VALUE.sub("<REDACTED>", value)
    value = URL_PASSWORD_VALUE.sub(r"\1<REDACTED>\3", value)
    return SENSITIVE_ASSIGNMENT_VALUE.sub(r"\1<REDACTED>", value)


def _redact_sensitive_json(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = key.lower().replace("-", "_")
            cleaned[key] = (
                "<REDACTED>"
                if normalized_key in SENSITIVE_FIELD_NAMES
                else _redact_sensitive_json(item)
            )
        return cleaned
    if isinstance(value, list):
        return [_redact_sensitive_json(item) for item in value]
    if isinstance(value, str):
        return _redact_sensitive_text(value)
    return value


def _cap_utf8(value: str) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= MAX_ERROR_BODY_BYTES:
        return value, False
    marker = TRUNCATION_MARKER.encode("utf-8")
    prefix = encoded[: MAX_ERROR_BODY_BYTES - len(marker)].decode("utf-8", errors="ignore")
    return prefix + TRUNCATION_MARKER, True


class OpenRouterHTTPError(OpenRouterError):
    def __init__(self, operation: str, endpoint: str, response: httpx.Response):
        decoded_body = response.content.decode(response.encoding or "utf-8", errors="replace")
        try:
            parsed_error = json.loads(decoded_body)
        except json.JSONDecodeError:
            sanitized_body = _redact_sensitive_text(decoded_body)
            provider_error = None
        else:
            provider_error = _redact_sensitive_json(parsed_error)
            sanitized_body = json.dumps(
                provider_error, ensure_ascii=False, separators=(",", ":")
            )
        body, body_was_truncated = _cap_utf8(sanitized_body)
        if body_was_truncated:
            provider_error = None
        response_headers = {
            key.lower(): _redact_sensitive_text(value)
            for key, value in response.headers.items()
            if key.lower() in SAFE_ERROR_RESPONSE_HEADERS
        }
        self.record = {
            "error_class": type(self).__name__,
            "operation": operation,
            "method": response.request.method,
            "endpoint": endpoint,
            "status_code": response.status_code,
            "response_body": body,
            "provider_error": provider_error,
            "response_headers": dict(sorted(response_headers.items())),
            "response_body_truncated": body_was_truncated,
            "safe_to_retry": False,
            "billing_status": "possibly_spent" if operation == "submit" else "not_applicable",
        }
        request_id = response_headers.get("x-request-id") or response_headers.get(
            "x-openrouter-request-id"
        )
        suffix = f" (request_id={request_id})" if request_id else ""
        super().__init__(
            f"OpenRouter {operation} failed with HTTP {response.status_code}{suffix}"
        )

    def to_record(self) -> dict[str, Any]:
        return self.record.copy()


def asset_reference(path_or_url: str, kind: str, frame_type: str | None = None) -> dict[str, Any]:
    if path_or_url.startswith(("https://", "data:")):
        url = path_or_url
    else:
        path = Path(path_or_url)
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        url = f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"
    key = f"{kind}_url"
    result: dict[str, Any] = {"type": key, key: {"url": url}}
    if frame_type:
        result["frame_type"] = frame_type
    return result


def request_digest(request: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()


def sanitized_request(request: dict[str, Any]) -> dict[str, Any]:
    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if not key.startswith("_")}
        if isinstance(value, list):
            return [clean(item) for item in value]
        if isinstance(value, str) and value.startswith("data:"):
            return f"<data-url sha256={hashlib.sha256(value.encode()).hexdigest()}>"
        return value

    return clean(request)


class OpenRouterVideoClient:
    def __init__(self, api_key: str | None = None, client: httpx.Client | None = None):
        api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise OpenRouterError("OPENROUTER_API_KEY is required for paid submission or polling")
        self._owned = client is None
        self.client = client or httpx.Client(
            base_url=API_BASE,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=60,
        )

    def close(self) -> None:
        if self._owned:
            self.client.close()

    def submit(self, request: dict[str, Any]) -> dict[str, Any]:
        payload = {key: value for key, value in request.items() if not key.startswith("_")}
        response = self.client.post("/videos", json=payload)
        if not response.is_success:
            raise OpenRouterHTTPError("submit", "/videos", response)
        return response.json()

    def status(self, job_id: str) -> dict[str, Any]:
        response = self.client.get(f"/videos/{job_id}")
        response.raise_for_status()
        return response.json()

    def wait(self, job_id: str, interval: float = 5, timeout: float = 1800) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.status(job_id)
            status = job.get("status") or job.get("data", {}).get("status")
            if status == "completed":
                return job
            if status in {"failed", "cancelled", "expired"}:
                raise OpenRouterError(f"Video job ended with status {status}: {job}")
            time.sleep(interval)
        raise TimeoutError(f"Timed out waiting for OpenRouter video job {job_id}")

    def download(self, job_id: str, destination: Path) -> str:
        response = self.client.get(f"/videos/{job_id}/content")
        response.raise_for_status()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(response.content)
        return hashlib.sha256(response.content).hexdigest()
