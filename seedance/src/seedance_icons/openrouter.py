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
AUTHORIZATION_VALUE = re.compile(
    r"(?i)(authorization\s*[:=]\s*bearer\s+)([^\s\"'\\]+)"
)


class OpenRouterError(RuntimeError):
    pass


def _redact_sensitive_text(value: str) -> str:
    return AUTHORIZATION_VALUE.sub(r"\1<REDACTED>", value)


class OpenRouterHTTPError(OpenRouterError):
    def __init__(self, operation: str, endpoint: str, response: httpx.Response):
        body_bytes = response.content[:MAX_ERROR_BODY_BYTES]
        body = _redact_sensitive_text(
            body_bytes.decode(response.encoding or "utf-8", errors="replace")
        )
        try:
            provider_error = json.loads(body)
        except json.JSONDecodeError:
            provider_error = None
        response_headers = {
            key.lower(): value
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
            "response_body_truncated": len(response.content) > MAX_ERROR_BODY_BYTES,
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
