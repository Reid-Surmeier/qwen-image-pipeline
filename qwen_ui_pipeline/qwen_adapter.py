"""Versioned language-neutral adapter around the inherited Qwen/OpenRouter kernel."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
from typing import Any, Callable, Mapping, Protocol

from .providers.openrouter import build_openrouter_request


QWEN_ADAPTER_PROTOCOL_VERSION = "1"
_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class QwenClient(Protocol):
    def generate(self, request: Mapping[str, Any]) -> dict[str, Any]: ...


class QwenKernelError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_bytes(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _exact_keys(value: Mapping[str, Any], keys: set[str]) -> bool:
    return set(value) == keys


def _decode_default(body: bytes, media_type: str) -> tuple[int, int, list[int]]:
    if media_type != "image/png":
        raise QwenKernelError("ADAPTER_RESULT_INVALID", "Qwen output must be PNG evidence.")
    try:
        from PIL import Image

        image = Image.open(io.BytesIO(body)).convert("RGBA")
        return image.width, image.height, [channel for pixel in image.getdata() for channel in pixel]
    except QwenKernelError:
        raise
    except Exception as error:
        raise QwenKernelError(
            "ADAPTER_RESULT_INVALID",
            "Qwen output could not be decoded as normalized RGBA.",
        ) from error


def _decode_reference(reference: Mapping[str, Any], index: int) -> str:
    required = {
        "slot",
        "application_path",
        "sha256",
        "payload_destination",
        "media_type",
        "bytes_base64",
    }
    if not _exact_keys(reference, required):
        raise QwenKernelError("ADAPTER_NOT_STARTED", "A reference record is not closed.")
    destination = f"/input_references/{index}/image_url/url"
    if (
        not isinstance(reference["slot"], str)
        or not reference["slot"]
        or not isinstance(reference["application_path"], str)
        or reference["payload_destination"] != destination
        or reference["media_type"] != "image/png"
        or not isinstance(reference["sha256"], str)
        or not isinstance(reference["bytes_base64"], str)
    ):
        raise QwenKernelError(
            "ADAPTER_NOT_STARTED",
            "A reference role, media type, or payload destination is invalid.",
        )
    try:
        body = base64.b64decode(reference["bytes_base64"], validate=True)
    except (ValueError, TypeError) as error:
        raise QwenKernelError("ADAPTER_NOT_STARTED", "Reference bytes are not canonical base64.") from error
    if base64.b64encode(body).decode("ascii") != reference["bytes_base64"] or _sha256(body) != reference["sha256"]:
        raise QwenKernelError("ADAPTER_NOT_STARTED", "Reference bytes do not match their SHA-256.")
    return f"data:image/png;base64,{reference['bytes_base64']}"


def invoke_qwen_kernel(
    document: Mapping[str, Any],
    *,
    client: QwenClient,
    decode_image: Callable[[bytes, str], tuple[int, int, list[int]]] = _decode_default,
) -> dict[str, Any]:
    """Validate one protocol request, invoke the inherited client once, and normalize evidence."""

    required = {
        "adapter_protocol_version",
        "operation",
        "provider",
        "model",
        "objective",
        "requested_count",
        "references",
    }
    if not isinstance(document, Mapping) or not _exact_keys(document, required):
        raise QwenKernelError("ADAPTER_NOT_STARTED", "The Qwen adapter request is not closed.")
    if (
        document["adapter_protocol_version"] != QWEN_ADAPTER_PROTOCOL_VERSION
        or document["operation"] != "invoke"
        or document["provider"] != "openrouter"
        or not isinstance(document["model"], str)
        or not document["model"]
        or not isinstance(document["objective"], str)
        or not document["objective"].strip()
        or isinstance(document["requested_count"], bool)
        or not isinstance(document["requested_count"], int)
        or not 1 <= document["requested_count"] <= 4
        or not isinstance(document["references"], list)
        or not 1 <= len(document["references"]) <= 4
    ):
        raise QwenKernelError("ADAPTER_NOT_STARTED", "Provider, model, count, objective, or protocol is invalid.")

    reference_urls = [
        _decode_reference(reference, index)
        for index, reference in enumerate(document["references"])
        if isinstance(reference, Mapping)
    ]
    if len(reference_urls) != len(document["references"]):
        raise QwenKernelError("ADAPTER_NOT_STARTED", "Every reference must be a closed object.")
    brief = {
        "model": document["model"],
        "objective": document["objective"],
        "output": {
            "count": document["requested_count"],
            "resolution": "2K",
            "aspect_ratio": "16:9",
        },
    }
    provider_request = build_openrouter_request(brief, reference_urls=reference_urls)
    if provider_request["model"] != document["model"] or provider_request["n"] != document["requested_count"]:
        raise QwenKernelError("ADAPTER_NOT_STARTED", "The inherited builder substituted locked request fields.")
    try:
        response = client.generate(provider_request)
    except Exception as error:
        raise QwenKernelError(
            "PROVIDER_AMBIGUOUS",
            "Provider submission failed after dispatch; reconcile this Run without resubmitting.",
        ) from None
    if not isinstance(response, dict) or not isinstance(response.get("data"), list):
        raise QwenKernelError("ADAPTER_RESULT_INVALID", "Provider response is not a supported object.")
    outputs = response["data"]
    if len(outputs) != document["requested_count"]:
        raise QwenKernelError("OUTPUT_COUNT_MISMATCH", "Provider response output count differs from the locked count.")

    normalized_outputs = []
    for index, item in enumerate(outputs, start=1):
        if not isinstance(item, dict) or not isinstance(item.get("b64_json"), str):
            raise QwenKernelError("ADAPTER_RESULT_INVALID", "Provider output is missing encoded image bytes.")
        media_type = item.get("media_type", "image/png")
        if media_type != "image/png":
            raise QwenKernelError("ADAPTER_RESULT_INVALID", "Provider output media type is unsupported.")
        try:
            image_bytes = base64.b64decode(item["b64_json"], validate=True)
        except (ValueError, TypeError) as error:
            raise QwenKernelError("ADAPTER_RESULT_INVALID", "Provider output bytes are not canonical base64.") from error
        width, height, pixels = decode_image(image_bytes, media_type)
        if (
            not isinstance(width, int)
            or isinstance(width, bool)
            or width < 1
            or not isinstance(height, int)
            or isinstance(height, bool)
            or height < 1
            or not isinstance(pixels, list)
            or len(pixels) != width * height * 4
            or any(isinstance(channel, bool) or not isinstance(channel, int) or not 0 <= channel <= 255 for channel in pixels)
        ):
            raise QwenKernelError("ADAPTER_RESULT_INVALID", "Decoded RGBA evidence is malformed.")
        raster = _canonical_bytes({"height": height, "pixels": pixels, "width": width})
        normalized_outputs.append(
            {
                "application_path": f"outputs/donor-{index:02d}.rgba.json",
                "media_type": "application/vnd.qwen.rgba+json",
                "body_base64": base64.b64encode(raster).decode("ascii"),
                "sha256": _sha256(raster),
            }
        )

    provider_id = response.get("id", response.get("request_id"))
    if not isinstance(provider_id, str) or _SAFE_IDENTIFIER.fullmatch(provider_id) is None:
        raise QwenKernelError("ADAPTER_RESULT_INVALID", "Provider response lacks a safe request identifier.")
    receipt = _canonical_bytes({"id": provider_id, "status": "completed"})
    return {
        "adapter_protocol_version": QWEN_ADAPTER_PROTOCOL_VERSION,
        "provider": "openrouter",
        "model": document["model"],
        "provider_evidence": {
            "media_type": "application/json",
            "body_base64": base64.b64encode(receipt).decode("ascii"),
            "sha256": _sha256(receipt),
        },
        "outputs": normalized_outputs,
    }
