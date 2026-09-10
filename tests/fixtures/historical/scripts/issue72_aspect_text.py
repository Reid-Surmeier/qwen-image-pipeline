"""Issue #72 paired aspect/copy experiment.

Four existing 5:4 outputs from Issue #53 are immutable comparison evidence.
This harness may submit only the four matched 4:3 requests. It creates a
durable attempt record and global submission lock before every paid request;
any ambiguity blocks all later seeds and is never retried.

Commands:
    prepare             write the frozen plan and compiled 4:3 brief
    submit SEED         submit one preregistered 4:3 OpenRouter request
    review-crops        create bounded title/list crop pairs for review
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qwen_ui_pipeline import (
    OpenRouterImageClient,
    build_openrouter_request,
    write_run_artifacts,
)
from qwen_ui_pipeline.prompt_manifest import compile_edit_brief
from scripts.issue53_seed_variance import BRIEF as ISSUE53_BRIEF
from scripts.issue53_seed_variance import SOURCE as ISSUE53_SOURCE


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "artifacts" / "benchmarks" / "issue-72-aspect-text"
SOURCE = ROOT / ISSUE53_SOURCE["path"]
SOURCE_SHA256 = ISSUE53_SOURCE["sha256"]
MODEL = "qwen/qwen-image-3-pro"
SEEDS = (11, 733, 4242, 20260826)
INCREMENTAL_ESTIMATE_USD = 0.172
BRIEF_SHA256 = "a6773a069e0ce88a4d6ee48c790c376b1724c5dd49f3d84a709d18dfbd5d4264"
PROMPT_SHA256 = "4f65f2fc8742c0c04563735beb9077ae08f94f3100094bf6efa7d1f5cf5ec146"
PLAN_SHA256 = "e46ae2accdf9a9036bab152f80392b7395578fc00a9d975d3aaf0c8b2a1fcf2d"
SAFE_ATTEMPT_STATUSES = {"completed"}
TEXT_REGIONS = {
    "title-bar": (0, 0, 474, 25),
    "species-list": (0, 242, 172, 403),
}
INHERITED: dict[int, dict[str, Any]] = {
    11: {
        "file": "artifacts/benchmarks/issue-53-seed-variance/outputs/seed-11.png",
        "sha256": "5111d717fc41e8f70daf2c27a7f19a1a9298af7b53d4598b3a27e29864d7b9bc",
        "prompt_id": "f814d934-1c40-4e90-9d9d-6525ba1417cb",
        "cost_usd": 0.043,
    },
    733: {
        "file": "artifacts/benchmarks/issue-53-seed-variance/outputs/seed-733.png",
        "sha256": "68f6b2f9f5b345abaef4bbe8ea7f355d98598d83b50c992fde60576e31b345c7",
        "prompt_id": "5713915f-2f84-4d96-9b8e-7e548b917dcb",
        "cost_usd": 0.043,
    },
    4242: {
        "file": "artifacts/benchmarks/issue-53-seed-variance/outputs/seed-4242.png",
        "sha256": "26c7f97723f3c5b7505d00458fd08bb7153d7fd22ecabe89c295ce70c17b3fe4",
        "prompt_id": "84b29d7c-8892-4f55-a45d-b749c72181ef",
        "cost_usd": 0.043,
    },
    20260826: {
        "file": "artifacts/benchmarks/issue-53-seed-variance/outputs/seed-20260826.png",
        "sha256": "c53a53ba5be1415b18ece2008d725a9e3e2fdc54bd8dc773b413ae12d531daf4",
        "prompt_id": "f447b1be-a8ba-47ea-b49d-fae490ac3d9c",
        "cost_usd": 0.043,
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _json_bytes(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _create_json_exclusive(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(_json_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise
    _fsync_directory(path.parent)


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        _create_json_exclusive(temporary, value)
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _write_immutable(path: Path, data: bytes) -> None:
    """Create a prepared artifact once, or verify an identical prior copy."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        if path.read_bytes() != data:
            raise RuntimeError(f"prepared artifact is immutable: {path}")
        return
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise
    _fsync_directory(path.parent)


def _validated_source_bytes() -> bytes:
    data = SOURCE.read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Issue #72 Reference Screen identity mismatch")
    return data


def brief_for(seed: int, aspect_ratio: str = "4:3") -> dict[str, Any]:
    if seed not in SEEDS:
        raise ValueError(f"seed {seed} is not preregistered")
    brief = json.loads(json.dumps(ISSUE53_BRIEF))
    brief["output"]["aspect_ratio"] = aspect_ratio
    brief["output"]["seed"] = seed
    return brief


def request_for(seed: int, aspect_ratio: str = "4:3", *, include_reference: bool = True) -> dict[str, Any]:
    references = ()
    if include_reference:
        encoded = base64.b64encode(_validated_source_bytes()).decode("ascii")
        references = (f"data:image/png;base64,{encoded}",)
    return build_openrouter_request(
        brief_for(seed, aspect_ratio), reference_urls=references
    )


def _request_identity(request: Mapping[str, Any], seed: int) -> tuple[str, str]:
    request_bytes = json.dumps(request, separators=(",", ":")).encode("utf-8")
    request_sha256 = hashlib.sha256(request_bytes).hexdigest()
    return (
        request_sha256,
        f"issue-72-seed-{seed}-4x3-{request_sha256[:16]}",
    )


def _validate_inherited() -> None:
    for seed, record in INHERITED.items():
        path = ROOT / record["file"]
        if _sha256(path) != record["sha256"]:
            raise RuntimeError(f"inherited Issue #53 artifact mismatch for seed {seed}")


def prepare() -> None:
    _validated_source_bytes()
    _validate_inherited()
    brief_without_seed = json.loads(json.dumps(ISSUE53_BRIEF))
    brief_without_seed["output"]["aspect_ratio"] = "4:3"
    compiled_prompt = compile_edit_brief(brief_without_seed).prompt
    request_records = {}
    for seed in SEEDS:
        request_sha256, client_request_id = _request_identity(request_for(seed), seed)
        request_records[str(seed)] = {
            "client_request_id": client_request_id,
            "request_sha256": request_sha256,
        }
    plan = {
        "schema_version": "issue-72-aspect-text-v1",
        "issue": 72,
        "base_pr": 66,
        "base_commit": "2fd1e8d3d6473bc6ed932bdf13658fa4ff87772e",
        "provider": "openrouter",
        "model": MODEL,
        "source": {
            "file": str(SOURCE.relative_to(ROOT)),
            "sha256": SOURCE_SHA256,
            "dimensions": [474, 403],
        },
        "brief": {
            "file": "artifacts/benchmarks/issue-72-aspect-text/brief-4x3.json",
            "sha256": hashlib.sha256(_json_bytes(brief_without_seed)).hexdigest(),
        },
        "prompt": {
            "file": "artifacts/benchmarks/issue-72-aspect-text/prompt.txt",
            "sha256": hashlib.sha256((compiled_prompt + "\n").encode("utf-8")).hexdigest(),
        },
        "seeds": list(SEEDS),
        "inherited_arm": {
            "resolution": "1K",
            "aspect_ratio": "5:4",
            "requested_outputs": 4,
            "completed_outputs": 4,
            "incremental_cost_usd": 0,
            "prior_cost_usd": sum(record["cost_usd"] for record in INHERITED.values()),
            "artifacts": {str(seed): record for seed, record in INHERITED.items()},
        },
        "new_arm": {
            "resolution": "1K",
            "aspect_ratio": "4:3",
            "maximum_requests": 4,
            "maximum_outputs": 4,
            "estimated_cost_usd": INCREMENTAL_ESTIMATE_USD,
            "requests": request_records,
        },
        "frozen_non_geometry_fields": [
            "Reference Screen",
            "Edit Brief",
            "model",
            "resolution",
            "seed",
            "output count",
        ],
        "text_regions_xyxy_half_open": {
            name: list(box) for name, box in TEXT_REGIONS.items()
        },
        "artifact_classification": {
            "native_outputs": "comparison_evidence",
            "attempts_plan_and_manifests": "reproducibility_metadata",
            "bounded_crops": "comparison_evidence",
        },
        "stop_rule": (
            "Never resubmit a seed. An exclusive global lock serializes paid "
            "submissions. Any HTTP, transport, response-count, or persistence "
            "ambiguity keeps the lock and blocks every later seed."
        ),
    }
    _write_immutable(OUT / "plan.json", _json_bytes(plan))
    _write_immutable(OUT / "brief-4x3.json", _json_bytes(brief_without_seed))
    _write_immutable(OUT / "prompt.txt", (compiled_prompt + "\n").encode("utf-8"))
    print("prepared Issue #72: four inherited outputs, four new requests maximum")


def _validate_prepared_request(
    seed: int, request_sha256: str, client_request_id: str
) -> None:
    prepared_files = {
        OUT / "plan.json": PLAN_SHA256,
        OUT / "brief-4x3.json": BRIEF_SHA256,
        OUT / "prompt.txt": PROMPT_SHA256,
    }
    for path, expected_sha256 in prepared_files.items():
        if not path.is_file() or _sha256(path) != expected_sha256:
            raise SystemExit(f"prepared artifact identity mismatch: {path.name}")
    plan = json.loads((OUT / "plan.json").read_text(encoding="utf-8"))
    expected = plan["new_arm"]["requests"][str(seed)]
    if expected != {
        "client_request_id": client_request_id,
        "request_sha256": request_sha256,
    }:
        raise SystemExit(f"request for seed {seed} differs from the reviewed plan")


def _blocking_attempts() -> list[str]:
    attempts = OUT / "attempts"
    if not attempts.exists():
        return []
    blockers = []
    for path in sorted(attempts.glob("*.json")):
        try:
            status = json.loads(path.read_text(encoding="utf-8")).get("status")
        except (OSError, ValueError):
            status = "unreadable"
        if status not in SAFE_ATTEMPT_STATUSES:
            blockers.append(f"{path.name}:{status or 'missing-status'}")
    return blockers


def _acquire_lock(seed: int) -> Path:
    path = OUT / "image-submission.lock"
    try:
        _create_json_exclusive(
            path,
            {"seed": seed, "acquired_at": _now(), "purpose": "paid-image-submission"},
        )
    except FileExistsError as error:
        raise SystemExit(
            "image-submission.lock exists; reconcile the prior request before continuing"
        ) from error
    return path


def _release_lock(path: Path) -> None:
    path.unlink()
    _fsync_directory(path.parent)


def _safe_request(request: Mapping[str, Any]) -> dict[str, Any]:
    safe = dict(request)
    if "input_references" in safe:
        safe["input_references"] = [
            {"type": "image_url", "image_url": "[recorded separately]"}
        ]
    return safe


def submit(seed: int) -> None:
    if seed not in SEEDS:
        raise SystemExit(f"seed {seed} is not preregistered: {SEEDS}")
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise SystemExit("OPENROUTER_API_KEY is required")
    if not (OUT / "plan.json").exists():
        raise SystemExit("run prepare before submit")
    attempt_path = OUT / "attempts" / f"seed-{seed}-4x3.json"
    if attempt_path.exists():
        raise SystemExit(f"attempt exists for seed {seed}; refusing resubmission")
    blockers = _blocking_attempts()
    if blockers:
        raise SystemExit("a prior ambiguous attempt blocks every later seed: " + ", ".join(blockers))

    request = request_for(seed)
    request_sha256, client_request_id = _request_identity(request, seed)
    _validate_prepared_request(seed, request_sha256, client_request_id)
    lock_path = _acquire_lock(seed)
    blockers = _blocking_attempts()
    if blockers or attempt_path.exists():
        _release_lock(lock_path)
        reason = ", ".join(blockers) if blockers else attempt_path.name
        raise SystemExit(f"submission state changed while acquiring lock: {reason}")

    attempt: dict[str, Any] = {
        "seed": seed,
        "arm": "4:3",
        "status": "reserved-before-submit",
        "provider": "openrouter",
        "model": MODEL,
        "requested_outputs": 1,
        "completed_outputs": 0,
        "estimated_cost_usd": 0.043,
        "source_sha256": SOURCE_SHA256,
        "request_sha256": request_sha256,
        "client_request_id": client_request_id,
        "request": _safe_request(request),
        "reserved_at": _now(),
    }
    try:
        _create_json_exclusive(attempt_path, attempt)
    except FileExistsError as error:
        _release_lock(lock_path)
        raise SystemExit("attempt appeared concurrently; refusing submission") from error

    attempt.update(status="submitted", submitted_at=_now())
    _write_json(attempt_path, attempt)
    try:
        response = OpenRouterImageClient(api_key).generate(request)
    except Exception as error:
        attempt.update(
            status="ambiguous-provider-error",
            completed_at=_now(),
            error_type=type(error).__name__,
            error=str(error),
        )
        _write_json(attempt_path, attempt)
        raise SystemExit(
            "provider failure may be billed; keep global lock and stop all later seeds"
        ) from error

    output_count = sum(
        1
        for item in response.get("data", [])
        if isinstance(item, dict) and isinstance(item.get("b64_json"), str)
    )
    attempt.update(
        status="response-received-persisting" if output_count == 1 else "ambiguous-output-count",
        completed_at=_now(),
        completed_outputs=output_count,
        response_id=response.get("id"),
        usage=response.get("usage", {}),
    )
    _write_json(attempt_path, attempt)
    if output_count != 1:
        raise SystemExit("unexpected output count; keep global lock and stop")

    run_dir = OUT / "runs" / f"seed-{seed}-4x3"
    try:
        record = write_run_artifacts(
            run_dir,
            brief_for(seed),
            request,
            response,
            provenance={
                "issue": 72,
                "arm": "4:3",
                "seed": seed,
                "provider": "openrouter",
                "model": MODEL,
                "request_id": response.get("id"),
                "client_request_id": client_request_id,
                "request_sha256": request_sha256,
                "source_sha256": SOURCE_SHA256,
            },
        )
    except Exception as error:
        attempt.update(
            status="ambiguous-persistence-error",
            completed_at=_now(),
            error_type=type(error).__name__,
            error=str(error),
        )
        _write_json(attempt_path, attempt)
        raise SystemExit(
            "response persistence failed; keep global lock and stop"
        ) from error
    attempt.update(status="completed", completed_at=_now())
    _write_json(attempt_path, attempt)
    _release_lock(lock_path)
    cost = float(record.get("usage", {}).get("cost", math.nan))
    print(f"completed seed {seed} at 4:3; cost ${cost:.6f}")


def review_crops() -> None:
    from PIL import Image

    _validate_inherited()
    with Image.open(io.BytesIO(_validated_source_bytes())) as source_image:
        source = source_image.convert("RGB")
    crops_root = OUT / "review-crops"
    manifest: dict[str, Any] = {
        "schema_version": "issue-72-review-crops-v1",
        "source_sha256": SOURCE_SHA256,
        "normalization": "nearest-neighbour to 474x403 before cropping",
        "regions_xyxy_half_open": {
            name: list(box) for name, box in TEXT_REGIONS.items()
        },
        "source_crops": {},
        "candidates": {},
    }
    for name, box in TEXT_REGIONS.items():
        path = crops_root / "source" / f"{name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        source.crop(box).save(path, format="PNG")
        manifest["source_crops"][name] = {
            "file": str(path.relative_to(ROOT)),
            "sha256": _sha256(path),
        }
    for seed in SEEDS:
        candidates = {
            "5x4": ROOT / INHERITED[seed]["file"],
            "4x3": OUT / "runs" / f"seed-{seed}-4x3" / "image-01.png",
        }
        for arm, candidate_path in candidates.items():
            if not candidate_path.exists():
                raise RuntimeError(f"missing {arm} candidate for seed {seed}")
            with Image.open(candidate_path) as candidate_image:
                dimensions = list(candidate_image.size)
                normalized = candidate_image.convert("RGB").resize(
                    source.size, Image.Resampling.NEAREST
                )
            key = f"seed-{seed}-{arm}"
            manifest["candidates"][key] = {
                "source_file": str(candidate_path.relative_to(ROOT)),
                "source_sha256": _sha256(candidate_path),
                "native_dimensions": dimensions,
                "crops": {},
            }
            for name, box in TEXT_REGIONS.items():
                path = crops_root / key / f"{name}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                normalized.crop(box).save(path, format="PNG")
                manifest["candidates"][key]["crops"][name] = {
                    "file": str(path.relative_to(ROOT)),
                    "sha256": _sha256(path),
                }
    _write_json(crops_root / "manifest.json", manifest)
    print("wrote two bounded text crops for eight candidates")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: issue72_aspect_text.py prepare|submit SEED|review-crops")
    command = sys.argv[1]
    if command == "prepare":
        prepare()
    elif command == "submit" and len(sys.argv) == 3:
        submit(int(sys.argv[2]))
    elif command == "review-crops":
        review_crops()
    else:
        raise SystemExit("usage: issue72_aspect_text.py prepare|submit SEED|review-crops")
