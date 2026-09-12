"""Input-location adapter for preserved Muse procedures. No provider execution."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from .muse_composite import FORBID, REFINE


def owned(root: Path, path: str, home: Path | None = None) -> Path:
    result = ((home or root) / path).resolve(strict=True)
    if not result.is_relative_to(root):
        raise ValueError("Recipe input must remain inside the application")
    return result


def prepare(root: Path, recipe_path: str) -> dict:
    root = root.resolve(strict=True)
    recipe_file = owned(root, recipe_path)
    recipe = json.loads(recipe_file.read_text())
    procedure = recipe["procedure"]
    if "noForbidContents" in recipe and type(recipe["noForbidContents"]) is not bool:
        raise ValueError("The contents-guard exception must be an explicit boolean")
    inputs = []
    support = [recipe_file]
    if procedure == "edit":
        # Preserve e-ink generate.py's declared-input fallback, order and hash checks.
        plan_path = owned(root, recipe["plan"])
        support.append(plan_path)
        plan = json.loads(plan_path.read_text())
        item = next(item for item in plan["attempts"] if item["id"] == recipe["attempt"])
        prompt_path = owned(root, item["prompt"])
        support.append(prompt_path)
        prompt = prompt_path.read_text()
        if hashlib.sha256(prompt.encode()).hexdigest() != item["promptSha256"]:
            raise ValueError("Muse prompt hash drifted")
        declared_inputs = item.get("inputs")
        if declared_inputs is None:
            declared_inputs = [{"path": item["input"], "sha256": item["inputSha256"]}]
        for declared in declared_inputs:
            path = owned(root, declared["path"])
            if hashlib.sha256(path.read_bytes()).hexdigest() != declared["sha256"]:
                raise ValueError("Muse input hash drifted")
            inputs.append(path)
        size = item["size"]
    elif procedure == "dis-composite":
        spec_file = owned(root, recipe["spec"])
        support.append(spec_file)
        spec = json.loads(spec_file.read_text())
        home = spec_file.parent
        if recipe.get("refineFrom"):
            inputs = [owned(root, recipe["refineFrom"])]
            prompt = spec.get("refine_prompt") or REFINE
        else:
            prompt = spec["prompt"] if recipe.get("noForbidContents", False) else spec["prompt"] + "\n\n" + FORBID
            for token in spec["references"]:
                if token.startswith("dis:"):
                    pid = token.split(":", 1)[1]
                    if not pid.isdecimal(): raise ValueError("Invalid DIS photo identity")
                    hits = sorted((root / "corpus/dis/images").glob(f"{pid}-*.jpg"))
                    if not hits: raise ValueError("DIS master missing")
                    inputs.append(owned(root, str(hits[0])))
                else:
                    inputs.append(owned(root, token, home))
        size = spec["size"]
    elif procedure in {"image", "product-ad"}:
        prompt_path = owned(root, recipe["prompt"])
        support.append(prompt_path)
        prompt = prompt_path.read_text()
        if hashlib.sha256(prompt.encode()).hexdigest() != recipe["promptSha256"]:
            raise ValueError("Muse prompt hash drifted")
        size = recipe["size"]
        if procedure == "product-ad" and recipe.get("references"):
            raise ValueError("Invented-product donor requests exclude DIS photos and source-ad images")
        if procedure == "product-ad":
            support.append(owned(root, recipe["packet"]))
        inputs = [owned(root, path) for path in recipe.get("references", [])]
    else:
        raise ValueError("Unsupported saved Muse procedure")
    return {"procedure": procedure, "prompt": prompt, "size": size, "references": [
        {"path": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in inputs
    ], "sourceInputs": [{"applicationPath": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in support], "recipeSha256": hashlib.sha256(recipe_file.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--application", required=True)
    parser.add_argument("--recipe", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(Path(args.application), args.recipe)))
    except Exception:
        print('{"error":"recipe-invalid-or-input-hash-drift"}')
        raise SystemExit(2) from None
