"""Muse adapter for the saved DIS Image API requests; no creative prompt rewriting.

Issue #90: reuse the inherited client and normalized donor seam. The caller owns
reservation, budgets, persistence and approval. Source recipe: DIS gallery
6c1ac2cad9213823183d23823fe30d50b882678d, generate.py.
"""
from __future__ import annotations

import base64
import hashlib
import io
import math
import re
from typing import Any, Mapping

from .qwen_adapter import QwenClient, QwenKernelError, _canonical_bytes, _SAFE_IDENTIFIER


def invoke_muse_kernel(document: Mapping[str, Any], *, client: QwenClient) -> dict[str, Any]:
    """Submit exactly one locked Muse request; never retry an ambiguous dispatch."""
    keys = {"adapter_protocol_version", "operation", "provider", "model", "objective",
            "requested_count", "parameters", "references"}
    if (not isinstance(document, Mapping) or set(document) != keys
            or document["adapter_protocol_version"] != "1" or document["operation"] != "invoke"
            or document["provider"] != "openrouter" or document["model"] != "meta/muse-image"
            or not isinstance(document["objective"], str) or not document["objective"].strip()
            or type(document["requested_count"]) is not int or document["requested_count"] != 1
            or not isinstance(document["references"], list)):
        raise QwenKernelError("ADAPTER_NOT_STARTED", "Muse requires one image, an explicit model, and a closed request.")
    parameters = document["parameters"]
    if (not isinstance(parameters, Mapping) or set(parameters) != {"size"}
            or not isinstance(parameters["size"], str)
            or re.fullmatch(r"[1-9][0-9]{0,4}x[1-9][0-9]{0,4}", parameters["size"]) is None):
        raise QwenKernelError("ADAPTER_NOT_STARTED", "Muse size must be the saved procedure's width x height; seed is unsupported.")
    request = {"model": document["model"], "prompt": document["objective"], "n": 1, "size": parameters["size"]}
    references = []
    for index, reference in enumerate(document["references"]):
        if (not isinstance(reference, Mapping) or set(reference) != {
                "slot", "application_path", "sha256", "payload_destination", "media_type", "bytes_base64"}
                or reference["payload_destination"] != f"/input_references/{index}/image_url/url"
                or reference["media_type"] not in {"image/png", "image/jpeg", "image/webp"}
                or not isinstance(reference["slot"], str) or not reference["slot"]
                or not isinstance(reference["application_path"], str)):
            raise QwenKernelError("ADAPTER_NOT_STARTED", "A Muse reference is malformed or out of order.")
        try:
            raw = base64.b64decode(reference["bytes_base64"], validate=True)
            if (base64.b64encode(raw).decode() != reference["bytes_base64"]
                    or hashlib.sha256(raw).hexdigest() != reference["sha256"]):
                raise ValueError("reference mismatch")
            from PIL import Image
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                if Image.MIME.get(image.format) != reference["media_type"]:
                    raise ValueError("reference format mismatch")
        except Exception:
            raise QwenKernelError("ADAPTER_NOT_STARTED", "Muse reference bytes do not match their locked image evidence.") from None
        references.append({"type": "image_url", "image_url": {
            "url": f"data:{reference['media_type']};base64,{reference['bytes_base64']}"}})
    if references:
        request["input_references"] = references
    try:
        response = client.generate(request)
    except Exception:
        raise QwenKernelError("PROVIDER_AMBIGUOUS", "Muse dispatch is unreconciled; do not resubmit.") from None
    if not isinstance(response, dict) or not isinstance(response.get("data"), list):
        raise QwenKernelError("ADAPTER_RESULT_INVALID", "Muse returned malformed paid evidence.")
    if len(response["data"]) != 1:
        raise QwenKernelError("OUTPUT_COUNT_MISMATCH", "Muse completed count differs from the reserved count.")
    try:
        item = response["data"][0]
        raw = base64.b64decode(item.get("b64_json") or item.get("image"), validate=True)
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as decoded:
            media_type = Image.MIME.get(decoded.format)
            if media_type not in {"image/png", "image/jpeg", "image/webp"}:
                raise ValueError("unsupported image")
            rgba = decoded.convert("RGBA")
            raster = _canonical_bytes({"height": rgba.height, "pixels": list(rgba.tobytes()), "width": rgba.width})
    except Exception:
        raise QwenKernelError("ADAPTER_RESULT_INVALID", "Muse output cannot be decoded as supported image evidence.") from None
    actual_cost = (response.get("usage") or {}).get("cost")
    if actual_cost is not None and (type(actual_cost) not in (int, float) or not math.isfinite(actual_cost) or actual_cost < 0):
        raise QwenKernelError("ADAPTER_RESULT_INVALID", "Muse actual cost is malformed.")
    cost = ({"state": "unknown"} if actual_cost is None else
            {"state": "actual", "actual_cost_usd": f"{actual_cost:.6f}"})
    provider_id = response.get("id") or response.get("request_id") or response.get("task_id")
    if provider_id is not None and (not isinstance(provider_id, str) or _SAFE_IDENTIFIER.fullmatch(provider_id) is None):
        raise QwenKernelError("ADAPTER_RESULT_INVALID", "Muse response identity is unsafe.")
    receipt = _canonical_bytes({"id": provider_id, "status": "completed", "completed_count": 1,
        "cost": cost, "source_images": [{"media_type": media_type, "sha256": hashlib.sha256(raw).hexdigest(),
        "body_base64": base64.b64encode(raw).decode(), "normalized_sha256": hashlib.sha256(raster).hexdigest()}]})
    def evidence(body, media_type):
        return {"media_type": media_type, "body_base64": base64.b64encode(body).decode(),
                "sha256": hashlib.sha256(body).hexdigest()}
    return {"adapter_protocol_version": "1", "provider": "openrouter", "model": "meta/muse-image",
            "provider_evidence": evidence(receipt, "application/json"),
            "outputs": [{"application_path": "outputs/donor-01.rgba.json",
                         **evidence(raster, "application/vnd.qwen.rgba+json")}]}


def recover_muse_kernel(document: Mapping[str, Any]) -> dict[str, Any]:
    """Recover normalized pixels from the immutable receipt; no provider client exists here."""
    import json
    try:
        if set(document) != {"adapter_protocol_version", "operation", "model", "provider_evidence"} or document["adapter_protocol_version"] != "1" or document["operation"] != "recover" or document["model"] != "meta/muse-image":
            raise ValueError("invalid recovery")
        evidence = document["provider_evidence"]
        receipt_bytes = base64.b64decode(evidence["body_base64"], validate=True)
        if hashlib.sha256(receipt_bytes).hexdigest() != evidence["sha256"]:
            raise ValueError("receipt drift")
        receipt = json.loads(receipt_bytes)
        source, = receipt["source_images"]
        raw = base64.b64decode(source["body_base64"], validate=True)
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as image:
            if Image.MIME.get(image.format) != source["media_type"] or hashlib.sha256(raw).hexdigest() != source["sha256"]:
                raise ValueError("native image drift")
            rgba = image.convert("RGBA")
            raster = _canonical_bytes({"height":rgba.height,"pixels":list(rgba.tobytes()),"width":rgba.width})
        if hashlib.sha256(raster).hexdigest() != source["normalized_sha256"]:
            raise ValueError("normalized image mismatch")
        return {"adapter_protocol_version":"1","provider":"openrouter","model":"meta/muse-image",
                "provider_evidence":evidence,"outputs":[{"application_path":"outputs/donor-01.rgba.json",
                "media_type":"application/vnd.qwen.rgba+json","body_base64":base64.b64encode(raster).decode(),"sha256":source["normalized_sha256"]}]}
    except Exception:
        raise QwenKernelError("ADAPTER_RESULT_INVALID", "Persisted Muse receipt cannot recover the original pixels.") from None
