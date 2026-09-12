"""Issue #53: seed-variance characterization for one fixed Edit Brief.

One frozen task (the Issue #18 localized-replacement canonical brief), eight
distinct seeds, one output each, explicit OpenRouter via live ComfyUI. Every
non-seed setting is byte-identical across runs. Outputs are annotated against
the Issue #26 taxonomy to report per-class incidence across seeds.

Commands:
    submit SEED   submit one paid render (refuses if an attempt record exists)
    collect       download outputs, hashes, and provider usage
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

COMFY = "http://10.255.255.254:8188"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "artifacts" / "benchmarks" / "issue-53-seed-variance"
MODEL = "qwen/qwen-image-3-pro"
SEEDS = [11, 733, 4242, 20260826, 90210, 314159, 777001, 555]

SOURCE = {
    "path": "artifacts/references/plantstudio-main-window.png",
    "sha256": "c9ddeaa3cd27d0d5b502710ad12bc8f810529339c87b97a289b6d6932df8f45d",
}

BRIEF = {
    "objective": "Perform one surgical edit: replace the single selected tall thin flower inside the red selection rectangle with one upright seven-iron golf club. Change nothing else.",
    "reference_role": "Reference image 1 is the authoritative PlantStudio main-window screenshot (474 by 403). Match it exactly outside the red selection rectangle.",
    "provider": "openrouter",
    "model": MODEL,
    "output": {"resolution": "1K", "aspect_ratio": "5:4", "count": 1},
    "preservation_invariants": [
        "Keep the complete application window: title bar, menus, toolbar, plant canvas, species list, growth graph, age controls, tabs, and status bar in their original positions.",
        "Keep every unselected plant, label, number, icon, and pixel-scale spacing unchanged.",
        "Keep the Windows-era grey chrome, navy title bar, aliased pixel edges, limited palette, and low-resolution raster character.",
        "Do not change any text anywhere in the window.",
    ],
    "regions": [{
        "name": "red selection rectangle",
        "change": "Remove the selected flower and draw one upright seven-iron golf club in the same narrow vertical footprint: grip at top, straight steel shaft, compact angled iron head near the bottom, rendered in the same pixel-art style.",
        "preserve": ["the red selection rectangle itself"],
    }],
    "negative_constraints": [
        "No global redraw, modernization, smoothing, anti-aliasing upgrade, or invented UI.",
        "No golf ball, golfer, tee, flag, or any second golf object.",
    ],
    "quality_checks": [
        "At 100 percent zoom, pixels outside the red rectangle look identical to the reference.",
        "The club reads clearly as a seven-iron at original scale.",
    ],
}


def upload_source() -> str:
    import uuid
    data = (ROOT / SOURCE["path"]).read_bytes()
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
        f"filename=\"issue53-plantstudio.png\"\r\nContent-Type: image/png\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        f"{COMFY}/upload/image", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read())["name"]


def submit(seed: int) -> None:
    if seed not in SEEDS:
        raise SystemExit(f"seed {seed} is not in the pre-registered set {SEEDS}")
    attempt_path = OUT / "attempts" / f"seed-{seed}.json"
    attempt_path.parent.mkdir(parents=True, exist_ok=True)
    if attempt_path.exists():
        raise SystemExit(f"attempt record exists for seed {seed}; will not resubmit")
    brief = json.loads(json.dumps(BRIEF))
    brief["output"]["seed"] = seed
    uploaded = upload_source()
    graph = {
        "1": {"class_type": "LoadImage", "inputs": {"image": uploaded}},
        "2": {"class_type": "QwenImage3Render", "inputs": {
            "edit_brief_json": json.dumps(brief),
            "reference_images": ["1", 0],
        }},
        "3": {"class_type": "SaveImage", "inputs": {
            "images": ["2", 0], "filename_prefix": f"issue53/seed-{seed}",
        }},
        "4": {"class_type": "SaveText", "inputs": {
            "text": ["2", 1], "filename_prefix": f"issue53/seed-{seed}-meta",
            "format": "json",
        }},
    }
    attempt = {
        "seed": seed, "provider": "openrouter", "model": MODEL,
        "requested_outputs": 1, "source": SOURCE, "status": "submitted",
    }
    attempt_path.write_text(json.dumps(attempt, indent=2) + "\n")
    request = urllib.request.Request(
        f"{COMFY}/prompt", data=json.dumps({"prompt": graph}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=240) as response:
        result = json.loads(response.read())
    attempt["prompt_id"] = result["prompt_id"]
    attempt_path.write_text(json.dumps(attempt, indent=2) + "\n")
    print("submitted seed", seed, "prompt_id", result["prompt_id"])
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        time.sleep(5)
        with urllib.request.urlopen(f"{COMFY}/history/{result['prompt_id']}", timeout=30) as response:
            history = json.loads(response.read())
        if result["prompt_id"] in history:
            entry = history[result["prompt_id"]]
            attempt["status"] = entry.get("status", {}).get("status_str", "unknown")
            attempt["completed"] = entry.get("status", {}).get("completed", False)
            attempt["outputs"] = entry.get("outputs", {})
            attempt_path.write_text(json.dumps(attempt, indent=2) + "\n")
            print("finished", attempt["status"])
            return
    attempt["status"] = "ambiguous-timeout"
    attempt_path.write_text(json.dumps(attempt, indent=2) + "\n")
    raise SystemExit("ambiguous timeout: counted as spent; do not retry")


def collect() -> None:
    outputs_dir = OUT / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for attempt_path in sorted((OUT / "attempts").glob("*.json")):
        attempt = json.loads(attempt_path.read_text())
        key = f"seed-{attempt['seed']}"
        record = {"status": attempt.get("status"), "prompt_id": attempt.get("prompt_id"),
                  "files": [], "usage": None}
        for node_output in attempt.get("outputs", {}).values():
            for text in node_output.get("text", []):
                try:
                    meta = json.loads(text)
                except ValueError:
                    continue
                record["usage"] = meta.get("usage")
                (outputs_dir / f"{key}-meta.json").write_text(json.dumps(meta, indent=2) + "\n")
            for item in node_output.get("images", []):
                if not isinstance(item, dict):
                    continue
                query = urllib.parse.urlencode({
                    "filename": item["filename"],
                    "subfolder": item.get("subfolder", ""),
                    "type": item.get("type", "output"),
                })
                with urllib.request.urlopen(f"{COMFY}/view?{query}", timeout=120) as response:
                    data = response.read()
                local = outputs_dir / f"{key}.png"
                local.write_bytes(data)
                record["files"].append({
                    "file": local.name, "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                })
        manifest[key] = record
        print(key, record["status"])
    (OUT / "collection-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    if sys.argv[1] == "submit":
        submit(int(sys.argv[2]))
    elif sys.argv[1] == "collect":
        collect()
    else:
        raise SystemExit("unknown command")
