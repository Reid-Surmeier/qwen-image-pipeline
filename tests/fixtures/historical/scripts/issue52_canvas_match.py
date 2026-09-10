"""Issue #52 canvas-geometry ablation for the PlantStudio edit task.

The experiment freezes the Reference Screen, Edit Brief, seed, model, and
output count.  Only the output geometry changes between arms.  Each paid arm
is submitted separately and gets a durable attempt record *before* the network
request.  An existing attempt record is an unconditional no-retry sentinel.

Commands:
    prepare             write the frozen experiment plan and compiled brief
    submit ARM          submit exactly one paid OpenRouter image request
    score               write deterministic T20/T21/T22 indicators
    review-crops        write bounded source/candidate crop pairs for review

Paid policy: explicit OpenRouter Images API only, one output per request, four
preregistered requests maximum.  No arm can be resubmitted by this script.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qwen_ui_pipeline.prompt_manifest import compile_edit_brief
from qwen_ui_pipeline.providers.openrouter import write_run_artifacts


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "artifacts" / "benchmarks" / "issue-52-canvas-match"
SOURCE = ROOT / "artifacts" / "references" / "plantstudio-main-window.png"
BRIEF_SOURCE = ROOT / "artifacts" / "runs" / "golf-club-object-v002" / "brief.json"
ENDPOINT = "https://openrouter.ai/api/v1/images"
MODEL = "qwen/qwen-image-3-pro"
SEED = 1786
SOURCE_SHA256 = "c9ddeaa3cd27d0d5b502710ad12bc8f810529339c87b97a289b6d6932df8f45d"
BRIEF_SOURCE_SHA256 = "e5e12aa3056739123b04d764c8ee6fafa5458d7b4965a2c9ab40b2375590c3d5"
EDIT_REGION = (182, 78, 219, 243)  # half-open x0, y0, x1, y1
REVIEW_REGIONS = {
    "title-and-tools": (0, 0, 474, 74),
    "left-plant-canvas": (0, 74, 182, 250),
    "right-plant-canvas": (219, 74, 474, 250),
    "bottom-ui-and-edge": (0, 250, 474, 403),
}
SAFE_TERMINAL_ATTEMPT_STATUSES = {"completed", "rejected-http-4xx-unbilled"}

ARMS: dict[str, dict[str, Any]] = {
    "exact-size": {
        "size": "948x806",
        "estimated_cost_usd": 0.043,
        "intent": "exact 2x source pixel dimensions",
    },
    "nearest-1k": {
        "resolution": "1K",
        "aspect_ratio": "5:4",
        "estimated_cost_usd": 0.043,
        "intent": "nearest supported aspect at 1K",
    },
    "mismatch-1k": {
        "resolution": "1K",
        "aspect_ratio": "16:9",
        "estimated_cost_usd": 0.043,
        "intent": "deliberately mismatched landscape aspect at 1K",
    },
    "nearest-2k": {
        "resolution": "2K",
        "aspect_ratio": "5:4",
        "estimated_cost_usd": 0.078,
        "intent": "nearest supported aspect at 2K",
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
    """Create and durably sync a sentinel without a check-then-write race."""

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
    """Atomically replace JSON and durably sync both file and directory."""

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


def _validated_source_bytes() -> bytes:
    data = SOURCE.read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("frozen Reference Screen identity does not match Issue #52")
    return data


def _load_brief() -> dict[str, Any]:
    if _sha256(BRIEF_SOURCE) != BRIEF_SOURCE_SHA256:
        raise RuntimeError("frozen Edit Brief identity does not match Issue #52")
    brief = json.loads(BRIEF_SOURCE.read_text(encoding="utf-8"))
    brief["provider"] = "openrouter"
    brief["model"] = MODEL
    brief["output"] = {"count": 1, "seed": SEED}
    return brief


def _reference_url() -> str:
    encoded = base64.b64encode(_validated_source_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def request_for_arm(arm: str, *, include_reference: bool = True) -> dict[str, Any]:
    """Build one arm while keeping every non-geometry field identical."""

    if arm not in ARMS:
        raise ValueError(f"unknown arm: {arm}")
    brief = _load_brief()
    request: dict[str, Any] = {
        "model": MODEL,
        "prompt": compile_edit_brief(brief).prompt,
        "n": 1,
        "seed": SEED,
    }
    request.update(
        {key: value for key, value in ARMS[arm].items() if key in {"size", "resolution", "aspect_ratio"}}
    )
    if include_reference:
        request["input_references"] = [
            {"type": "image_url", "image_url": {"url": _reference_url()}}
        ]
    return request


def prepare() -> None:
    brief = _load_brief()
    plan = {
        "schema_version": "issue-52-canvas-match-v1",
        "issue": 52,
        "provider": "openrouter",
        "endpoint": ENDPOINT,
        "model": MODEL,
        "seed": SEED,
        "requested_outputs_per_arm": 1,
        "maximum_requests": len(ARMS),
        "maximum_outputs": len(ARMS),
        "estimated_total_cost_usd": sum(item["estimated_cost_usd"] for item in ARMS.values()),
        "source": {
            "path": str(SOURCE.relative_to(ROOT)),
            "sha256": SOURCE_SHA256,
            "dimensions": [474, 403],
            "role": "source_reference",
        },
        "brief_source": {
            "path": str(BRIEF_SOURCE.relative_to(ROOT)),
            "sha256": BRIEF_SOURCE_SHA256,
        },
        "edit_region_xyxy_half_open": list(EDIT_REGION),
        "artifact_classification": {
            "generated_outputs": "comparison_evidence",
            "attempt_records_and_manifests": "reproducibility_metadata",
            "bounded_review_crops": "comparison_evidence",
            "invalid_whole-screen_review": "rejected_candidate_evidence",
        },
        "arms": ARMS,
        "capability_snapshot": {
            "observed_at": "2026-08-27",
            "source": "https://openrouter.ai/api/v1/images/models/qwen/qwen-image-3-pro/endpoints",
            "resolution": ["1K", "2K"],
            "aspect_ratio": ["1:1", "1:2", "1:4", "2:1", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "9:16", "16:9"],
            "pricing_usd": {"input_reference": 0.003, "output_1k": 0.040, "output_2k": 0.075},
            "explicit_size_contract": "OpenRouter Images API documents explicit pixel size as authoritative",
        },
        "stop_rule": (
            "Never resubmit an arm. A durable global lock serializes paid image "
            "submissions. Any ambiguous HTTP, transport, response-count, or "
            "persistence outcome keeps that lock and blocks every later arm until "
            "the request is reconciled."
        ),
    }
    _write_json(OUT / "plan.json", plan)
    _write_json(OUT / "brief.json", brief)
    (OUT / "prompt.txt").write_text(compile_edit_brief(brief).prompt + "\n", encoding="utf-8")
    print(f"prepared {len(ARMS)} arms; estimated total ${plan['estimated_total_cost_usd']:.3f}")


def _safe_request(request: Mapping[str, Any]) -> dict[str, Any]:
    safe = dict(request)
    if "input_references" in safe:
        safe["input_references"] = [
            {"type": "image_url", "image_url": "[recorded separately]"}
        ]
    return safe


def _blocking_image_attempts() -> list[str]:
    attempts_directory = OUT / "attempts"
    if not attempts_directory.exists():
        return []
    blockers = []
    for path in sorted(attempts_directory.glob("*.json")):
        try:
            status = json.loads(path.read_text(encoding="utf-8")).get("status")
        except (OSError, ValueError):
            status = "unreadable"
        if status not in SAFE_TERMINAL_ATTEMPT_STATUSES:
            blockers.append(f"{path.name}:{status or 'missing-status'}")
    return blockers


def _acquire_image_submission_lock(arm: str) -> Path:
    lock_path = OUT / "image-submission.lock"
    try:
        _create_json_exclusive(
            lock_path,
            {"arm": arm, "acquired_at": _now(), "purpose": "paid-image-submission"},
        )
    except FileExistsError as error:
        raise SystemExit(
            "image-submission.lock exists; reconcile the in-flight or ambiguous "
            "request before any later arm"
        ) from error
    return lock_path
def _release_image_submission_lock(lock_path: Path) -> None:
    lock_path.unlink()
    _fsync_directory(lock_path.parent)


def submit(arm: str) -> None:
    if arm not in ARMS:
        raise SystemExit(f"unknown arm {arm!r}; choose one of: {', '.join(ARMS)}")
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise SystemExit("OPENROUTER_API_KEY is required")
    if not (OUT / "plan.json").exists():
        raise SystemExit("run prepare before submit")

    attempt_path = OUT / "attempts" / f"{arm}.json"
    if attempt_path.exists():
        raise SystemExit(
            f"attempt record already exists for {arm}; possible prior billing -- refusing resubmission"
        )
    blockers = _blocking_image_attempts()
    if blockers:
        raise SystemExit(
            "a prior non-terminal or ambiguous attempt blocks every later arm: "
            + ", ".join(blockers)
        )

    request_body = request_for_arm(arm)
    request_bytes = json.dumps(request_body, separators=(",", ":")).encode("utf-8")
    request_sha256 = hashlib.sha256(request_bytes).hexdigest()
    client_request_id = f"issue-52-{arm}-{request_sha256[:16]}"
    lock_path = _acquire_image_submission_lock(arm)
    blockers = _blocking_image_attempts()
    if blockers or attempt_path.exists():
        _release_image_submission_lock(lock_path)
        reason = ", ".join(blockers) if blockers else attempt_path.name
        raise SystemExit(f"submission state changed while acquiring the lock: {reason}")

    attempt: dict[str, Any] = {
        "arm": arm,
        "status": "reserved-before-submit",
        "provider": "openrouter",
        "endpoint": ENDPOINT,
        "model": MODEL,
        "seed": SEED,
        "requested_outputs": 1,
        "completed_outputs": 0,
        "estimated_cost_usd": ARMS[arm]["estimated_cost_usd"],
        "source_sha256": SOURCE_SHA256,
        "request_sha256": request_sha256,
        "client_request_id": client_request_id,
        "request": _safe_request(request_body),
        "reserved_at": _now(),
    }
    try:
        _create_json_exclusive(attempt_path, attempt)
    except FileExistsError as error:
        _release_image_submission_lock(lock_path)
        raise SystemExit(
            f"attempt record already exists for {arm}; refusing resubmission"
        ) from error

    http_request = urllib.request.Request(
        ENDPOINT,
        data=request_bytes,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "qwen-ui-pipeline-issue-52/1",
        },
    )
    attempt["status"] = "submitted"
    attempt["submitted_at"] = _now()
    _write_json(attempt_path, attempt)
    try:
        with urllib.request.urlopen(http_request, timeout=600) as response:
            response_body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(8192).decode("utf-8", "replace")
        if 400 <= error.code < 500:
            attempt.update(
                status="rejected-http-4xx-unbilled",
                completed_at=_now(),
                http_status=error.code,
                error=detail,
            )
            _write_json(attempt_path, attempt)
            _release_image_submission_lock(lock_path)
            raise SystemExit(
                f"{arm} rejected with HTTP {error.code}; recorded and will not retry"
            ) from error
        attempt.update(
            status="ambiguous-http-server-error",
            completed_at=_now(),
            http_status=error.code,
            error=detail,
        )
        _write_json(attempt_path, attempt)
        raise SystemExit(
            f"HTTP {error.code} may have reached the provider; keep the global "
            "lock and stop every later arm"
        ) from error
    except Exception as error:
        attempt.update(
            status="ambiguous-transport-error",
            completed_at=_now(),
            error_type=type(error).__name__,
            error=str(error),
        )
        _write_json(attempt_path, attempt)
        raise SystemExit(
            f"ambiguous failure for {arm}; count as possibly spent and stop all submissions"
        ) from error

    if not isinstance(response_body, dict):
        attempt.update(status="ambiguous-invalid-response", completed_at=_now())
        _write_json(attempt_path, attempt)
        raise SystemExit("non-object response; count as possibly spent and stop")
    output_count = sum(
        1
        for item in response_body.get("data", [])
        if isinstance(item, dict) and isinstance(item.get("b64_json"), str)
    )
    attempt.update(
        status="response-received-persisting" if output_count == 1 else "ambiguous-output-count",
        completed_at=_now(),
        completed_outputs=output_count,
        response_id=response_body.get("id"),
        created=response_body.get("created"),
        usage=response_body.get("usage", {}),
    )
    _write_json(attempt_path, attempt)
    if output_count != 1:
        raise SystemExit(f"unexpected output count {output_count}; stop all submissions")

    run_dir = OUT / "runs" / arm
    try:
        record = write_run_artifacts(
            run_dir,
            _load_brief(),
            request_body,
            response_body,
            provenance={
                "issue": 52,
                "arm": arm,
                "provider": "openrouter",
                "model": MODEL,
                "request_id": response_body.get("id"),
                "client_request_id": client_request_id,
                "request_sha256": request_sha256,
                "source_sha256": SOURCE_SHA256,
                "attempt_record": str(attempt_path.relative_to(ROOT)),
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
            "provider response could not be durably persisted; keep the global "
            "lock and stop"
        ) from error
    attempt.update(status="completed", completed_at=_now())
    _write_json(attempt_path, attempt)
    _release_image_submission_lock(lock_path)
    print(
        f"completed {arm}: {len(record['outputs'])} output, "
        f"cost ${float(record.get('usage', {}).get('cost', 0.0)):.6f}"
    )


def _difference_metrics(reference, candidate, *, mask=None) -> dict[str, Any]:
    from PIL import Image, ImageChops

    diff = ImageChops.difference(reference, candidate).convert("RGB")
    if mask is not None:
        black = reference.copy()
        black.paste((0, 0, 0), (0, 0, reference.width, reference.height))
        diff = Image.composite(diff, black, mask)
        pixel_count = sum(mask.histogram()[1:])
    else:
        pixel_count = reference.width * reference.height
    histograms = diff.histogram()
    absolute_sum = sum(
        value * count
        for channel in range(3)
        for value, count in enumerate(histograms[channel * 256 : (channel + 1) * 256])
    )
    max_channel = diff.getextrema()
    changed = diff.convert("L").point(lambda value: 255 if value > 8 else 0)
    if mask is not None:
        changed = Image.composite(changed, Image.new("L", changed.size, 0), mask)
    changed_count = sum(changed.histogram()[1:])
    return {
        "mean_absolute_channel_delta": absolute_sum / max(1, pixel_count * 3),
        "pixels_with_luma_delta_gt_8": changed_count,
        "fraction_with_luma_delta_gt_8": changed_count / max(1, pixel_count),
        "max_channel_delta": [item[1] for item in max_channel],
    }


def score_image(path: Path) -> dict[str, Any]:
    from PIL import Image, ImageDraw

    with Image.open(io.BytesIO(_validated_source_bytes())) as source_image:
        reference = source_image.convert("RGB")
    with Image.open(path) as candidate_image:
        candidate = candidate_image.convert("RGB")
        original_dimensions = candidate.size
    normalized = candidate.resize(reference.size, Image.Resampling.NEAREST)

    outside = Image.new("1", reference.size, 1)
    x0, y0, x1, y1 = EDIT_REGION
    ImageDraw.Draw(outside).rectangle((x0, y0, x1 - 1, y1 - 1), fill=0)
    edge = Image.new("1", reference.size, 0)
    draw = ImageDraw.Draw(edge)
    edge_width = 8
    draw.rectangle((0, 0, reference.width - 1, edge_width - 1), fill=1)
    draw.rectangle((0, reference.height - edge_width, reference.width - 1, reference.height - 1), fill=1)
    draw.rectangle((0, 0, edge_width - 1, reference.height - 1), fill=1)
    draw.rectangle((reference.width - edge_width, 0, reference.width - 1, reference.height - 1), fill=1)

    source_ratio = reference.width / reference.height
    output_ratio = original_dimensions[0] / original_dimensions[1]
    ratio_error = abs(output_ratio - source_ratio) / source_ratio
    return {
        "file": str(path.relative_to(ROOT)),
        "sha256": _sha256(path),
        "output_dimensions": list(original_dimensions),
        "source_dimensions": list(reference.size),
        "source_aspect_ratio": source_ratio,
        "output_aspect_ratio": output_ratio,
        "relative_aspect_error": ratio_error,
        "T21_aspect_ratio_drift": "absent" if ratio_error <= 0.001 else "present",
        "T20_outside_region_indicator": _difference_metrics(reference, normalized, mask=outside),
        "T22_edge_strip_indicator": _difference_metrics(reference, normalized, mask=edge),
        "measurement_note": "Candidate resized to 474x403 with nearest-neighbour before pixel indicators; raw values are evidence, not an automatic visual verdict.",
    }


def score() -> None:
    _validated_source_bytes()
    results: dict[str, Any] = {
        "schema_version": "issue-52-deterministic-scores-v1",
        "source_sha256": SOURCE_SHA256,
        "edit_region_xyxy_half_open": list(EDIT_REGION),
        "arms": {},
    }
    for arm in ARMS:
        attempt_path = OUT / "attempts" / f"{arm}.json"
        if not attempt_path.exists():
            results["arms"][arm] = {"status": "not-submitted"}
            continue
        attempt = json.loads(attempt_path.read_text(encoding="utf-8"))
        if attempt.get("status") != "completed":
            results["arms"][arm] = {
                "status": attempt.get("status", "unknown"),
                "http_status": attempt.get("http_status"),
            }
            continue
        image_path = OUT / "runs" / arm / "image-01.png"
        if not image_path.exists():
            raise RuntimeError(f"completed arm {arm} has no collected image")
        results["arms"][arm] = {"status": "completed", **score_image(image_path)}
    _write_json(OUT / "deterministic-scores.json", results)
    print(json.dumps(results, indent=2))


def write_review_crops() -> None:
    """Create bounded, normalized crop pairs for a separate reviewer."""

    from PIL import Image

    with Image.open(io.BytesIO(_validated_source_bytes())) as source_image:
        reference = source_image.convert("RGB")
    crops_root = OUT / "review-crops"
    manifest: dict[str, Any] = {
        "schema_version": "issue-52-review-crops-v1",
        "source_sha256": SOURCE_SHA256,
        "normalization": "nearest-neighbour to 474x403 before cropping",
        "regions_xyxy_half_open": {
            name: list(box) for name, box in REVIEW_REGIONS.items()
        },
        "source_crops": {},
        "candidate_crops": {},
    }
    for name, box in REVIEW_REGIONS.items():
        path = crops_root / "source" / f"{name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        reference.crop(box).save(path, format="PNG")
        manifest["source_crops"][name] = {
            "file": str(path.relative_to(ROOT)),
            "sha256": _sha256(path),
        }
    for arm in ARMS:
        candidate_path = OUT / "runs" / arm / "image-01.png"
        if not candidate_path.exists():
            raise RuntimeError(f"missing completed output for {arm}")
        with Image.open(candidate_path) as candidate_image:
            normalized = candidate_image.convert("RGB").resize(
                reference.size, Image.Resampling.NEAREST
            )
        manifest["candidate_crops"][arm] = {}
        for name, box in REVIEW_REGIONS.items():
            path = crops_root / arm / f"{name}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            normalized.crop(box).save(path, format="PNG")
            manifest["candidate_crops"][arm][name] = {
                "file": str(path.relative_to(ROOT)),
                "sha256": _sha256(path),
            }
    _write_json(crops_root / "manifest.json", manifest)
    print(
        f"wrote {len(REVIEW_REGIONS)} bounded crop pairs for {len(ARMS)} arms"
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(
            "usage: issue52_canvas_match.py prepare|submit ARM|score|review-crops"
        )
    command = sys.argv[1]
    if command == "prepare":
        prepare()
    elif command == "submit" and len(sys.argv) == 3:
        submit(sys.argv[2])
    elif command == "score":
        score()
    elif command == "review-crops":
        write_review_crops()
    else:
        raise SystemExit(
            "usage: issue52_canvas_match.py prepare|submit ARM|score|review-crops"
        )
