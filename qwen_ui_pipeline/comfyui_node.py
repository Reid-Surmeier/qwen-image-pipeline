"""ComfyUI node for Qwen Image 3 through OpenRouter."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
from typing import Any

from .partner_controls import (
    MODELS,
    PROVIDERS,
    SIZE_MODES,
    build_partner_edit_brief,
    build_partner_text_brief,
)
from .providers.alibaba import AlibabaImageClient
from .providers.openrouter import DEFAULT_TIMEOUT_SECONDS, OpenRouterImageClient, resolve_timeout_seconds
from .providers.router import generate_with_provider


def _openrouter_timeout_seconds() -> float:
    """``QWEN_OPENROUTER_TIMEOUT_SECONDS`` overrides the client's 180 s default.

    Kept as a name for this module's callers; the single definition lives beside the
    default it overrides, in ``providers.openrouter``.
    """
    return resolve_timeout_seconds()


def _reference_data_urls(reference_images: Any) -> list[str]:
    from PIL import Image

    output = []
    if reference_images is None:
        return output
    # Preserve the legacy QwenImage3Render behavior: silently use at most the
    # first four images from its batch input.  The new Partner-compatible node
    # has stricter one-image-per-role validation in _partner_reference_records.
    for tensor in reference_images[:4]:
        pixels = tensor.detach().cpu().numpy()
        pixels = (pixels.clip(0, 1) * 255).round().astype("uint8")
        image = Image.fromarray(pixels, mode="RGB")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        output.append(f"data:image/png;base64,{encoded}")
    return output


def _partner_reference_records(*named_images: Any) -> list[dict[str, Any]]:
    """Encode one image per visible socket so role names remain unambiguous."""
    records = []
    missing_role = None
    for index, images in enumerate(named_images, start=1):
        if images is None:
            missing_role = missing_role or f"image_{index}"
        elif missing_role is not None:
            raise ValueError(f"image_{index} requires {missing_role} to be connected")
        elif len(images) != 1:
            raise ValueError(
                f"image_{index} must contain exactly one image; batches would make "
                "the visible @ImageN roles ambiguous"
            )

    from PIL import Image

    for index, images in enumerate(named_images, start=1):
        if images is None:
            continue
        tensor = images[0]
        pixels = tensor.detach().cpu().numpy()
        pixels = (pixels.clip(0, 1) * 255).round().astype("uint8")
        image = Image.fromarray(pixels[..., :3], mode="RGB")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        image_bytes = buffer.getvalue()
        records.append(
            {
                "role": f"image_{index}",
                "width": image.width,
                "height": image.height,
                "sha256": hashlib.sha256(image_bytes).hexdigest(),
                "data_url": "data:image/png;base64,"
                + base64.b64encode(image_bytes).decode("ascii"),
            }
        )
    return records


def _response_tensors(response: dict[str, Any]):
    import numpy
    import torch
    from PIL import Image

    tensors = []
    for item in response.get("data", []):
        if not isinstance(item, dict) or not isinstance(item.get("b64_json"), str):
            continue
        image_bytes = base64.b64decode(item["b64_json"], validate=True)
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        pixels = numpy.asarray(image, dtype=numpy.float32) / 255.0
        tensors.append(torch.from_numpy(pixels).unsqueeze(0))
    if not tensors:
        raise RuntimeError("Qwen Image 3 response did not contain an image")
    return torch.cat(tensors, dim=0)


def _provider_clients(provider: str) -> tuple[Any, Any]:
    if provider == "openrouter":
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            raise ValueError("OpenRouter client is unavailable")
        return OpenRouterImageClient(api_key, timeout=_openrouter_timeout_seconds()), None
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        raise ValueError("Alibaba client is unavailable")
    return None, AlibabaImageClient(api_key)


def _response_hashes(response: dict[str, Any]) -> list[str]:
    hashes = []
    for item in response.get("data", []):
        if isinstance(item, dict) and isinstance(item.get("b64_json"), str):
            image_bytes = base64.b64decode(item["b64_json"], validate=True)
            hashes.append(hashlib.sha256(image_bytes).hexdigest())
    return hashes


def _partner_render(
    brief: dict[str, Any], reference_records: list[dict[str, Any]]
) -> tuple[Any, str, str]:
    openrouter_client, alibaba_client = _provider_clients(brief["provider"])
    result = generate_with_provider(
        brief,
        reference_urls=[record["data_url"] for record in reference_records],
        openrouter_client=openrouter_client,
        alibaba_client=alibaba_client,
    )
    response = result.response
    reference_metadata = [
        {key: record[key] for key in ("role", "width", "height", "sha256")}
        for record in reference_records
    ]
    output_hashes = _response_hashes(response)
    metadata = {
        "provider": result.provider,
        "model": result.request["model"],
        "controls": brief["output"],
        "references": reference_metadata,
        "requested_output_count": brief["output"]["count"],
        "completed_output_count": len(output_hashes),
        "output_sha256": output_hashes,
        "usage": response.get("usage", {}),
    }
    request_id = response.get("request_id") or response.get("id")
    if request_id is not None:
        metadata["request_id"] = request_id
    return (
        _response_tensors(response),
        json.dumps(brief, sort_keys=True),
        json.dumps(metadata, sort_keys=True),
    )


def _common_partner_inputs() -> dict[str, Any]:
    return {
        "provider": (list(PROVIDERS), {"default": "openrouter"}),
        "model": (list(MODELS), {"default": "qwen-image-3.0-pro"}),
        "prompt": ("STRING", {"multiline": True, "default": ""}),
        "negative_prompt": ("STRING", {"multiline": True, "default": ""}),
        "width": ("INT", {"default": 1024, "min": 256, "max": 2560, "step": 16}),
        "height": ("INT", {"default": 1024, "min": 256, "max": 2560, "step": 16}),
        "count": ("INT", {"default": 1, "min": 1, "max": 6}),
        "seed": (
            "INT",
            {"default": 42, "min": 0, "max": 2_147_483_647, "control_after_generate": True},
        ),
        "prompt_extend": ("BOOLEAN", {"default": False}),
        "watermark": ("BOOLEAN", {"default": False}),
    }


class QwenImage3TextToImage:
    """Partner-compatible visible controls backed by explicit local providers."""

    CATEGORY = "Qwen UI Pipeline/Partner-compatible"
    FUNCTION = "render"
    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("images", "edit_brief_json", "run_metadata")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": _common_partner_inputs()}

    def render(
        self,
        provider: str,
        model: str,
        prompt: str,
        negative_prompt: str,
        width: int,
        height: int,
        count: int,
        seed: int,
        prompt_extend: bool,
        watermark: bool,
    ):
        brief = build_partner_text_brief(
            provider=provider,
            model=model,
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            count=count,
            seed=seed,
            prompt_extend=prompt_extend,
            watermark=watermark,
        )
        return _partner_render(brief, [])


class QwenImage3Edit:
    """Portable three-reference edit node with stable visible image roles."""

    CATEGORY = "Qwen UI Pipeline/Partner-compatible"
    FUNCTION = "render"
    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("images", "edit_brief_json", "run_metadata")

    @classmethod
    def INPUT_TYPES(cls):
        required = _common_partner_inputs()
        required["size_mode"] = (list(SIZE_MODES), {"default": "custom"})
        required["image_1"] = ("IMAGE",)
        return {
            "required": required,
            "optional": {
                "image_2": ("IMAGE",),
                "image_3": ("IMAGE",),
            },
        }

    def render(
        self,
        provider: str,
        model: str,
        prompt: str,
        negative_prompt: str,
        width: int,
        height: int,
        count: int,
        seed: int,
        prompt_extend: bool,
        watermark: bool,
        size_mode: str,
        image_1,
        image_2=None,
        image_3=None,
    ):
        reference_records = _partner_reference_records(image_1, image_2, image_3)
        brief = build_partner_edit_brief(
            provider=provider,
            model=model,
            prompt=prompt,
            negative_prompt=negative_prompt,
            size_mode=size_mode,
            width=width,
            height=height,
            count=count,
            seed=seed,
            prompt_extend=prompt_extend,
            watermark=watermark,
            reference_dimensions=[
                (record["width"], record["height"]) for record in reference_records
            ],
        )
        return _partner_render(brief, reference_records)


class QwenImage3Render:
    """Execute a structured Edit Brief without exposing credentials in a workflow."""

    CATEGORY = "Qwen UI Pipeline"
    FUNCTION = "render"
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "run_metadata")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "edit_brief_json": (
                    "STRING",
                    {"multiline": True, "default": '{"objective": "Describe the edit"}'},
                ),
            },
            "optional": {"reference_images": ("IMAGE",)},
        }

    def render(self, edit_brief_json: str, reference_images=None):
        brief = json.loads(edit_brief_json)
        if not isinstance(brief, dict):
            raise ValueError("Edit Brief must be a JSON object")
        openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
        alibaba_key = os.environ.get("DASHSCOPE_API_KEY", "")
        result = generate_with_provider(
            brief,
            reference_urls=_reference_data_urls(reference_images),
            openrouter_client=(
                OpenRouterImageClient(
                    openrouter_key, timeout=_openrouter_timeout_seconds()
                )
                if openrouter_key
                else None
            ),
            alibaba_client=(AlibabaImageClient(alibaba_key) if alibaba_key else None),
        )
        request = result.request
        response = result.response
        if result.provider == "openrouter":
            resolution = request["resolution"]
            aspect_ratio = request["aspect_ratio"]
            count = request["n"]
            seed = request.get("seed")
        else:
            parameters = request["parameters"]
            resolution = parameters["size"]
            aspect_ratio = brief.get("output", {}).get("aspect_ratio")
            count = parameters["n"]
            seed = parameters.get("seed")
        metadata = json.dumps(
            {
                "provider": result.provider,
                "model": request["model"],
                "resolution": resolution,
                "aspect_ratio": aspect_ratio,
                "count": count,
                "seed": seed,
                "usage": response.get("usage", {}),
            },
            sort_keys=True,
        )
        return (_response_tensors(response), metadata)


class ReferenceRegionComposite:
    """Copy one generated region onto an otherwise untouched reference image."""

    CATEGORY = "Qwen UI Pipeline"
    FUNCTION = "composite"
    RETURN_TYPES = ("IMAGE",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "reference_images": ("IMAGE",),
                "generated_images": ("IMAGE",),
                "region": (
                    "STRING",
                    {"default": "0,0,64,64", "multiline": False},
                ),
            }
        }

    def composite(self, reference_images, generated_images, region: str):
        import torch.nn.functional as functional

        try:
            x, y, width, height = (int(value.strip()) for value in region.split(","))
        except (TypeError, ValueError) as error:
            raise ValueError("Region must be x,y,width,height") from error
        if min(x, y, width, height) < 0 or width == 0 or height == 0:
            raise ValueError("Region coordinates must be non-negative with positive size")

        # ComfyUI's SaveImage floors float-to-byte conversion. Centering each
        # reference value inside its original byte bucket prevents widespread
        # one-level drift after a LoadImage -> SaveImage round trip.
        reference = (
            ((reference_images[:1] * 255.0).round() + 0.25).clamp(0, 255) / 255.0
        )
        target_height, target_width = reference.shape[1:3]
        if x + width > target_width or y + height > target_height:
            raise ValueError("Region extends outside the reference image")

        generated = functional.interpolate(
            generated_images.movedim(-1, 1),
            size=(target_height, target_width),
            mode="nearest",
        ).movedim(1, -1)
        output = reference.expand(generated.shape[0], -1, -1, -1).clone()
        output[:, y : y + height, x : x + width, :] = generated[
            :, y : y + height, x : x + width, :
        ]
        return (output,)


NODE_CLASS_MAPPINGS = {
    "ReferenceRegionComposite": ReferenceRegionComposite,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ReferenceRegionComposite": "Reference Region Composite",
}
