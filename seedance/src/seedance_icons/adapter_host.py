"""Closed stdio bridge from Conductor's Seedance adapter to OpenRouter."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import tempfile
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from seedance_icons.openrouter import OpenRouterVideoClient


class AdapterError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _record(value: Any, message: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AdapterError("ADAPTER_NOT_STARTED", message)
    return value


def _job_id(value: Any) -> str:
    job = _record(value, "Provider response is not an object.")
    nested = job.get("data") if isinstance(job.get("data"), dict) else {}
    result = job.get("id") or job.get("job_id") or nested.get("id") or nested.get("job_id")
    if not isinstance(result, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", result) is None:
        raise AdapterError("ADAPTER_RESULT_INVALID", "Provider response has no safe job identity.")
    return result


def _status(value: Any) -> str:
    job = _record(value, "Provider poll response is not an object.")
    nested = job.get("data") if isinstance(job.get("data"), dict) else {}
    status = job.get("status") or nested.get("status")
    if status in {"completed", "succeeded"}:
        return "completed"
    if status in {"pending", "queued", "processing", "running", "in_progress"}:
        return "pending"
    if status in {"failed", "cancelled", "expired", "rejected"}:
        raise AdapterError("ADAPTER_RESULT_INVALID", f"Provider job ended with status {status}.")
    raise AdapterError("ADAPTER_RESULT_INVALID", "Provider returned an unknown job status.")


def _wire_request(document: dict[str, Any]) -> dict[str, Any]:
    if document.get("adapter_protocol_version") != "1" or document.get("operation") not in {"submit", "poll"}:
        raise AdapterError("ADAPTER_NOT_STARTED", "Unsupported adapter request.")
    payload = _record(document.get("payload"), "Adapter payload is not an object.")
    video_plan = _record(document.get("video_plan"), "Video Plan is missing.")
    expected = _record(video_plan.get("expectedMedia"), "Expected video media is missing.")
    model = document.get("model")
    objective = document.get("objective")
    references = payload.get("input_references")
    if not isinstance(model, str) or not isinstance(objective, str) or not isinstance(references, list):
        raise AdapterError("ADAPTER_NOT_STARTED", "Model, objective, or references are malformed.")
    wire: dict[str, Any] = {
        "model": model,
        "prompt": objective,
        "duration": expected.get("durationSeconds"),
        "size": f"{expected.get('width')}x{expected.get('height')}",
        "generate_audio": expected.get("audioExpected"),
    }
    input_references: list[dict[str, Any]] = []
    frame_images: list[dict[str, Any]] = []
    for index, reference in enumerate(references):
        item = _record(reference, "A prepared reference is malformed.")
        if set(item) == {"video_url"}:
            kind, media_type = "video", "video/mp4"
        elif set(item) == {"image_url"}:
            kind, media_type = "image", None
        else:
            raise AdapterError("ADAPTER_NOT_STARTED", "A prepared reference kind is unsupported.")
        url = _record(_record(item[f"{kind}_url"], "Reference wrapper is malformed.").get("url"), "Reference evidence is malformed.")
        encoded, digest = url.get("bytesBase64"), url.get("sha256")
        if not isinstance(encoded, str) or not isinstance(digest, str):
            raise AdapterError("ADAPTER_NOT_STARTED", "Reference bytes or digest are missing.")
        try:
            body = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise AdapterError("ADAPTER_NOT_STARTED", "Reference bytes are not base64.") from error
        actual_media_type = url.get("mediaType")
        allowed_media_types = {"video/mp4"} if kind == "video" else {"image/png", "image/jpeg", "image/webp", "application/vnd.qwen.rgba+json"}
        if hashlib.sha256(body).hexdigest() != digest or actual_media_type not in allowed_media_types:
            raise AdapterError("ADAPTER_NOT_STARTED", "Reference bytes do not match their locked evidence.")
        media_type = str(actual_media_type)
        provider_reference = {
            "type": f"{kind}_url",
            f"{kind}_url": {"url": f"data:{media_type};base64,{encoded}"},
        }
        if kind == "image":
            provider_reference["frame_type"] = "first_frame" if index == 0 else "last_frame"
            frame_images.append(provider_reference)
        else:
            input_references.append(provider_reference)
    if frame_images:
        wire["frame_images"] = frame_images
    if input_references:
        wire["input_references"] = input_references
    return wire


def _evidence(value: dict[str, Any]) -> dict[str, str]:
    body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return {"media_type": "application/json", "body_base64": base64.b64encode(body).decode(), "sha256": hashlib.sha256(body).hexdigest()}


def _cost(value: dict[str, Any]) -> dict[str, str]:
    nested = value.get("data") if isinstance(value.get("data"), dict) else {}
    usage = value.get("usage") or nested.get("usage")
    raw = usage.get("cost") if isinstance(usage, dict) else None
    if isinstance(raw, bool) or not isinstance(raw, (str, int, float)):
        return {"state": "unknown"}
    try:
        amount = Decimal(str(raw))
    except InvalidOperation:
        return {"state": "unknown"}
    if not amount.is_finite() or amount < 0:
        return {"state": "unknown"}
    whole, _, fraction = format(amount, "f").partition(".")
    if len(fraction) > 6:
        return {"state": "unknown"}
    actual = f"{whole}.{fraction.rstrip('0').ljust(2, '0')}"
    return {"state": "actual", "actual_cost_usd": actual}


def execute(document: Any, *, client: Any) -> dict[str, Any]:
    request = _record(document, "Adapter input is not an object.")
    model = request.get("model")
    if request.get("operation") == "submit":
        job_id = _job_id(client.submit(_wire_request(request)))
        receipt = {"job_id": job_id, "status": "submitted"}
        return {"adapter_protocol_version": "1", "provider": "openrouter", "model": model, "job_id": job_id, "provider_evidence": _evidence(receipt)}
    _wire_request(request)
    job_id = request.get("job_id")
    if not isinstance(job_id, str) or not job_id:
        raise AdapterError("ADAPTER_NOT_STARTED", "A poll requires one exact job identity.")
    polled = client.status(job_id)
    if _job_id(polled) != job_id:
        raise AdapterError("ADAPTER_RESULT_INVALID", "Provider poll substituted the job identity.")
    status = _status(polled)
    common = {"adapter_protocol_version": "1", "provider": "openrouter", "model": model, "job_id": job_id, "status": status}
    if status == "pending":
        receipt = {"job_id": job_id, "status": "pending"}
        return {**common, "provider_evidence": _evidence(receipt)}
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "output.mp4"
        digest = client.download(job_id, output)
        body = output.read_bytes()
    if hashlib.sha256(body).hexdigest() != digest:
        raise AdapterError("ADAPTER_RESULT_INVALID", "Downloaded video changed after provider receipt.")
    output_receipt = {"application_path": "outputs/output.mp4", "media_type": "video/mp4", "sha256": digest}
    cost = _cost(polled)
    receipt = {"job_id": job_id, "status": "completed", "outputs": [output_receipt], "completed_count": 1, "cost": cost}
    return {**common, "provider_evidence": _evidence(receipt), "outputs": [{**output_receipt, "body_base64": base64.b64encode(body).decode()}], "completed_count": 1, "cost": cost}


def main() -> int:
    try:
        document = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        document = None
    if not isinstance(document, dict):
        error = AdapterError("ADAPTER_NOT_STARTED", "Adapter input is not JSON.")
    elif not os.environ.get("OPENROUTER_API_KEY"):
        error = AdapterError("ADAPTER_NOT_STARTED", "The logical OpenRouter credential is unavailable.")
    else:
        try:
            client = OpenRouterVideoClient()
        except Exception:  # noqa: BLE001 - no provider/client diagnostic may cross the stdio trust seam
            error = AdapterError("ADAPTER_NOT_STARTED", "The OpenRouter client could not be initialized.")
        else:
            try:
                result = execute(document, client=client)
            except AdapterError as caught:
                error = caught
            except Exception:  # noqa: BLE001 - post-dispatch uncertainty must fail closed without leaking diagnostics
                error = AdapterError("PROVIDER_AMBIGUOUS", "The provider outcome is unknown; do not resubmit.")
            else:
                print(json.dumps(result, sort_keys=True, separators=(",", ":")))
                return 0
            finally:
                client.close()
    print(json.dumps({"adapter_error": {"code": error.code, "message": str(error)}}, sort_keys=True, separators=(",", ":")))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
