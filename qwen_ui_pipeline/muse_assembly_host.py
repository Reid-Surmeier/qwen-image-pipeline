"""Application-location adapter around the unchanged saved product Assembly."""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path
from . import muse_product_assembly as kernel
from .muse_recipe import owned

SETTINGS = {"PRODUCT_REGIONS", "PRODUCT_CLEANUP_REGIONS", "OLD_LEADER_ERASE_REGIONS", "OLD_LEADERS", "BANNED", "VARIANTS", "KODAK_CATEGORIES", "KODAK_CALLOUTS", "KODAK_ANCHORS"}


def assemble(application: Path, recipe_path: str) -> dict:
    application = application.resolve(strict=True)
    recipe_file = owned(application, recipe_path)
    recipe = json.loads(recipe_file.read_text())
    settings = recipe["settings"]
    if set(settings) != SETTINGS:
        raise ValueError("The complete saved application Assembly recipe is required")
    source_home = owned(application, recipe["donorHome"])
    output_home = (application / recipe["outputHome"]).resolve()
    if not output_home.is_relative_to(application) or output_home.exists():
        raise ValueError("Assembly needs a new application-owned output directory")
    layouts_file = owned(application, recipe["layouts"])
    layouts = json.loads(layouts_file.read_text())
    packets = json.loads((source_home / "packets.json").read_text())
    plan = json.loads((source_home / "generation-plan.json").read_text())
    if not packets or not plan["attempts"] or not settings["VARIANTS"]:
        raise ValueError("Assembly requires packets, donors and selected variants")
    for packet in packets:
        if not any(attempt["packetSignature"] == packet["signature"] for attempt in plan["attempts"]):
            raise ValueError("Every packet requires a recorded donor")
    # Every input needed by this invocation is checked before any output is written.
    for path, expected in recipe["inputHashes"].items():
        if kernel.sha256(owned(application, path)) != expected:
            raise ValueError("Assembly input hash drift")
    needed = {str(layouts_file.relative_to(application)), str((source_home / "packets.json").relative_to(application)), str((source_home / "generation-plan.json").relative_to(application))}
    for template in {variant["template"] for variant in settings["VARIANTS"]}:
        layout = layouts[template]
        for path in layout.get("sources", [layout.get("source")]):
            needed.add(str(owned(application, path).relative_to(application)))
    for name, font_path in layouts["fonts"].items():
        font_file = Path(font_path).resolve(strict=True)
        if not (font_file.is_relative_to(application) or font_file.is_relative_to("/usr/share/fonts")):
            raise ValueError("Font must be an application asset or installed system font")
        if kernel.sha256(font_file) != recipe["fontHashes"].get(font_path):
            raise ValueError("Font hash drift")
    for attempt in plan["attempts"]:
        if not isinstance(attempt["id"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", attempt["id"]):
            raise ValueError("Unsafe donor attempt identity")
        run_path = source_home / "attempts" / attempt["id"] / "run.json"
        needed.add(str(owned(application, str(run_path)).relative_to(application)))
        run = json.loads(run_path.read_text())
        if run.get("completedOutputs") != 1 or run.get("provider") != "openrouter" or run.get("model") != "meta/muse-image" or run.get("error") or run.get("ambiguousPossiblyBilled"):
            raise ValueError("Donor is not reconciled to one Muse output")
        donor = owned(application, run["images"][0]["file"])
        if kernel.sha256(donor) != run["images"][0]["sha256"]:
            raise ValueError("Donor hash drift")
        needed.add(str(donor.relative_to(application)))
    if not needed.issubset(recipe["inputHashes"]):
        raise ValueError("Assembly recipe must lock every layout, packet, plan, run and source/donor image")
    kernel.ROOT = application
    kernel.HOME = output_home
    for key, value in settings.items():
        setattr(kernel, key, {name: set(words) for name, words in value.items()} if key == "BANNED" else value)
    output_home.mkdir(parents=True)
    for attempt in plan["attempts"]:
        source_run = json.loads((source_home / "attempts" / attempt["id"] / "run.json").read_text())
        target = output_home / "attempts" / attempt["id"]
        target.mkdir(parents=True)
        # Copy only the fields consumed by the preserved Assembly, not historical approvals.
        subset = {key: source_run[key] for key in ["images", "provider", "model", "costUsd"]}
        (target / "run.json").write_text(json.dumps(subset, indent=2) + "\n")
    sources = {name: kernel.load_source(layouts[name]) for name in {variant["template"] for variant in settings["VARIANTS"]}}
    clean = {name: kernel.clean_template(name, layouts[name], source) for name, source in sources.items()}
    records = []
    for packet in packets:
        for variant in settings["VARIANTS"]:
            records.append(kernel.assemble_one(len(records) + 1, packet, variant, plan["attempts"], layouts, sources, clean))
    report = {"recipeSha256": kernel.sha256(recipe_file), "sourceManifest": "procedures/muse/source-manifest.json",
              "records": records, "paidCalls": 0, "approval": "unverified",
              "checks": {"assembly": "passed" if all(record["machineValid"] for record in records) else "failed",
                         "finalOcrThreshold": "passed" if all(record["ocrTokenCoverage"] >= .75 for record in records) else "failed",
                         "independentVisualReview": "unverified"}}
    report_path = output_home / "assembly-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    return {"reportPath": str(report_path.relative_to(application)), "report": report}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--application", required=True)
    parser.add_argument("--recipe", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(assemble(Path(args.application), args.recipe)))
    except Exception:
        print('{"error":"assembly-input-or-execution-failed","approval":"unverified"}')
        raise SystemExit(2) from None
