from __future__ import annotations

import ast
import json
import sys
import tomllib
from pathlib import Path
from typing import Any


ALLOWED_DISPOSITIONS = {
    "retained implementation",
    "compatibility adapter",
    "neutral fixture",
    "application-owned",
    "Git-history only",
}
LEDGER_PATH = Path("migration/entrypoints.json")
RENDERED_PATH = Path("MIGRATION_LEDGER.md")
COMPATIBILITY_TYPESCRIPT_PATH = Path("modules/conductor/compatibility-surfaces.ts")


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _module_name(path: Path, repository: Path) -> str:
    return ".".join(path.relative_to(repository).with_suffix("").parts)


def _mapping_string_keys(tree: ast.Module, name: str) -> set[str]:
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            continue
        if not isinstance(node.value, ast.Dict):
            return set()
        return {
            key.value
            for key in node.value.keys
            if isinstance(key, ast.Constant) and isinstance(key.value, str)
        }
    return set()


def discover_retained_surfaces(repository: Path) -> set[str]:
    surfaces: set[str] = set()
    project = tomllib.loads((repository / "pyproject.toml").read_text(encoding="utf-8"))
    console_surfaces = {
        "qwen-ui-pipeline": "python-cli.generate",
        "qwen-worker-capacity": "python-cli.capacity",
    }
    for name in project.get("project", {}).get("scripts", {}):
        surfaces.add(console_surfaces.get(name, f"python-console.{name}"))

    comfy_path = repository / "qwen_ui_pipeline/comfyui_node.py"
    for name in _mapping_string_keys(_parse(comfy_path), "NODE_CLASS_MAPPINGS"):
        surfaces.add(f"comfyui.{name}")

    workflow_path = repository / "qwen_ui_pipeline/comfyui_workflow.py"
    for node in _parse(workflow_path).body:
        if isinstance(node, ast.FunctionDef) and node.name.startswith("build_") and node.name.endswith("_workflow"):
            surfaces.add(f"python-api.{_module_name(workflow_path, repository)}.{node.name}")

    for path in sorted((repository / "qwen_ui_pipeline/providers").glob("*.py")):
        module = _module_name(path, repository)
        for node in _parse(path).body:
            if isinstance(node, ast.FunctionDef):
                if node.name == "generate_with_provider" or (
                    node.name.startswith("build_") and node.name.endswith("_request")
                ) or node.name == "write_run_artifacts":
                    surfaces.add(f"python-api.{module}.{node.name}")
            elif isinstance(node, ast.ClassDef) and node.name.endswith("Client"):
                for child in node.body:
                    if isinstance(child, ast.FunctionDef) and child.name in {"generate", "review"}:
                        surfaces.add(f"python-api.{module}.{node.name}.{child.name}")
    return surfaces


def _call_name(call: ast.Call) -> str | None:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        parts = [call.func.attr]
        value = call.func.value
        while isinstance(value, ast.Attribute):
            parts.append(value.attr)
            value = value.value
        if isinstance(value, ast.Name):
            parts.append(value.id)
            return ".".join(reversed(parts))
    return None


def _submission_aliases(tree: ast.Module) -> set[str]:
    aliases = {"generate_with_provider"}
    assignments: list[tuple[str, ast.expr]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for imported in node.names:
                if imported.name == "generate_with_provider":
                    aliases.add(imported.asname or imported.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            value = node.value
            if value is None:
                continue
            assignments.extend(
                (target.id, value)
                for target in targets
                if isinstance(target, ast.Name)
            )
    changed = True
    while changed:
        changed = False
        for target, value in assignments:
            source_is_submission = (
                isinstance(value, ast.Name) and value.id in aliases
            ) or (
                isinstance(value, ast.Attribute)
                and value.attr in {"generate", "generate_with_provider"}
            )
            if source_is_submission and target not in aliases:
                aliases.add(target)
                changed = True
    return aliases


class _BypassVisitor(ast.NodeVisitor):
    def __init__(self, relative_path: str, tree: ast.Module) -> None:
        self.relative_path = relative_path
        self.context: list[str] = []
        self.bypasses: set[str] = set()
        self.submission_aliases = _submission_aliases(tree)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.context.append(node.name)
        self.generic_visit(node)
        self.context.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.context.append(node.name)
        self.generic_visit(node)
        self.context.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.context.append(node.name)
        self.generic_visit(node)
        self.context.pop()

    def visit_Call(self, node: ast.Call) -> None:
        call_name = _call_name(node)
        is_provider_generate = isinstance(node.func, ast.Attribute) and node.func.attr == "generate"
        is_provider_transport = (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in {"_opener", "urlopen"}
        )
        is_provider_dispatch = (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "generate_with_provider"
        ) or (
            isinstance(node.func, ast.Name)
            and node.func.id in self.submission_aliases
        )
        if is_provider_generate or is_provider_dispatch or is_provider_transport:
            owner = ".".join(self.context) or "<module>"
            display_name = call_name or ast.unparse(node.func)
            self.bypasses.add(f"{self.relative_path}:{owner}->{display_name}")
        self.generic_visit(node)


def discover_direct_provider_bypasses(repository: Path) -> set[str]:
    bypasses: set[str] = set()
    package = repository / "qwen_ui_pipeline"
    if not package.is_dir():
        return bypasses
    for path in sorted(package.rglob("*.py")):
        relative = path.relative_to(repository).as_posix()
        tree = _parse(path)
        visitor = _BypassVisitor(relative, tree)
        visitor.visit(tree)
        bypasses.update(visitor.bypasses)
    return bypasses


def render_markdown(document: dict[str, Any]) -> str:
    rows = []
    for entry in sorted(document["entries"], key=lambda item: item["surface"]):
        rows.append(
            "| {surface} | {disposition} | {replacement} | {retirement} |".format(
                surface=entry["surface"],
                disposition=entry["disposition"],
                replacement=entry["replacement"],
                retirement=entry["retirementCondition"],
            )
        )
    bypass_rows = [
        "| {path} | {replacement} | {retirement} |".format(
            path=entry["path"],
            replacement=entry["replacement"],
            retirement=entry["retirementCondition"],
        )
        for entry in sorted(document["directProviderBypasses"], key=lambda item: item["path"])
    ]
    compatibility_rows = [
        "| {surface} | {retirement} |".format(
            surface=entry["surface"],
            retirement=entry["retirementCondition"],
        )
        for entry in sorted(document["compatibilitySurfaces"], key=lambda item: item["surface"])
    ]
    return "\n".join(
        (
            "# Migration ledger",
            "",
            "<!-- Generated from migration/entrypoints.json by scripts/validate_migration_ledger.py. -->",
            "",
            "This ledger records the inherited execution surfaces retained during the Conductor migration. A recorded bypass is known debt, not an approved normal path; later contraction tickets must remove it before removing its entry.",
            "",
            "| Surface | Disposition | Replacement interface | Retirement condition |",
            "| --- | --- | --- | --- |",
            *rows,
            "",
            "## Additive Conductor compatibility surfaces",
            "",
            "These new version-1 surfaces delegate to Conductor now. The inherited callers above remain recorded bypasses until Issues #28 and #29 switch them to these surfaces.",
            "",
            "| Surface | Retirement condition |",
            "| --- | --- |",
            *compatibility_rows,
            "",
            "## Direct-provider bypasses still present",
            "",
            "| Call path | Replacement interface | Retirement condition |",
            "| --- | --- | --- |",
            *bypass_rows,
            "",
        )
    )


def render_compatibility_typescript(document: dict[str, Any]) -> str:
    rows = [
        f"  {json.dumps(entry['surface'])}: {json.dumps(entry['retirementCondition'])},"
        for entry in sorted(document["compatibilitySurfaces"], key=lambda item: item["surface"])
    ]
    return "\n".join(
        (
            "/* Generated from migration/entrypoints.json by scripts/validate_migration_ledger.py. */",
            "",
            "export const COMPATIBILITY_RETIREMENT_CONDITIONS = Object.freeze({",
            *rows,
            "} as const)",
            "",
            "export type CompatibilitySurface = keyof typeof COMPATIBILITY_RETIREMENT_CONDITIONS",
            "",
        )
    )


def validate_document(document: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(document, dict):
        return ["migration ledger root must be an object"]
    if document.get("schemaVersion") != 1:
        errors.append("migration ledger schemaVersion must be 1")
    entries = document.get("entries")
    if not isinstance(entries, list):
        errors.append("migration ledger entries must be an array")
    else:
        surfaces: list[str] = []
        for index, entry in enumerate(entries):
            label = f"entries[{index}]"
            if not isinstance(entry, dict):
                errors.append(f"{label} must be an object")
                continue
            surface = entry.get("surface")
            if not isinstance(surface, str) or not surface:
                errors.append(f"{label}.surface must be a non-empty string")
            else:
                surfaces.append(surface)
            if entry.get("disposition") not in ALLOWED_DISPOSITIONS:
                errors.append(f"{label}.disposition is not a closed migration disposition")
            for field in ("replacement", "retirementCondition"):
                if not isinstance(entry.get(field), str) or not entry[field].strip():
                    errors.append(f"{label}.{field} must be a non-empty string")
        if len(surfaces) != len(set(surfaces)):
            errors.append("migration ledger surfaces must be unique")

    compatibility_entries = document.get("compatibilitySurfaces")
    if not isinstance(compatibility_entries, list):
        errors.append("compatibilitySurfaces must be an array")
    else:
        compatibility_surfaces: list[str] = []
        for index, entry in enumerate(compatibility_entries):
            label = f"compatibilitySurfaces[{index}]"
            if not isinstance(entry, dict):
                errors.append(f"{label} must be an object")
                continue
            for field in ("surface", "retirementCondition"):
                if not isinstance(entry.get(field), str) or not entry[field].strip():
                    errors.append(f"{label}.{field} must be a non-empty string")
            if isinstance(entry.get("surface"), str) and entry["surface"]:
                compatibility_surfaces.append(entry["surface"])
        if len(compatibility_surfaces) != len(set(compatibility_surfaces)):
            errors.append("compatibility surface identifiers must be unique")

    bypass_entries = document.get("directProviderBypasses")
    if not isinstance(bypass_entries, list):
        errors.append("directProviderBypasses must be an array")
    else:
        bypasses: list[str] = []
        for index, entry in enumerate(bypass_entries):
            label = f"directProviderBypasses[{index}]"
            if not isinstance(entry, dict):
                errors.append(f"{label} must be an object")
                continue
            path = entry.get("path")
            if not isinstance(path, str) or not path:
                errors.append(f"{label}.path must be a non-empty string")
            else:
                bypasses.append(path)
            for field in ("replacement", "retirementCondition"):
                if not isinstance(entry.get(field), str) or not entry[field].strip():
                    errors.append(f"{label}.{field} must be a non-empty string")
        if len(bypasses) != len(set(bypasses)):
            errors.append("direct-provider bypass paths must be unique")
    return errors


def validate_repository(repository: Path) -> tuple[list[str], dict[str, Any]]:
    ledger_path = repository / LEDGER_PATH
    try:
        parsed = json.loads(ledger_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"cannot read {LEDGER_PATH}: {error}"], {}
    errors = validate_document(parsed)
    if errors or not isinstance(parsed, dict):
        return errors, parsed if isinstance(parsed, dict) else {}
    document = parsed
    surfaces = [entry["surface"] for entry in document["entries"]]
    bypasses = [entry["path"] for entry in document["directProviderBypasses"]]

    discovered_surfaces = discover_retained_surfaces(repository)
    if set(surfaces) != discovered_surfaces:
        missing = sorted(discovered_surfaces - set(surfaces))
        stale = sorted(set(surfaces) - discovered_surfaces)
        errors.append(f"migration ledger surface inventory differs: missing={missing}, stale={stale}")
    discovered_bypasses = discover_direct_provider_bypasses(repository)
    if set(bypasses) != discovered_bypasses:
        missing = sorted(discovered_bypasses - set(bypasses))
        stale = sorted(set(bypasses) - discovered_bypasses)
        errors.append(f"direct-provider bypass inventory differs: missing={missing}, stale={stale}")

    rendered_path = repository / RENDERED_PATH
    if not rendered_path.is_file() or rendered_path.read_text(encoding="utf-8") != render_markdown(document):
        errors.append(f"{RENDERED_PATH} is stale; regenerate it from {LEDGER_PATH}")
    compatibility_path = repository / COMPATIBILITY_TYPESCRIPT_PATH
    if (
        not compatibility_path.is_file()
        or compatibility_path.read_text(encoding="utf-8")
        != render_compatibility_typescript(document)
    ):
        errors.append(
            f"{COMPATIBILITY_TYPESCRIPT_PATH} is stale; regenerate it from {LEDGER_PATH}"
        )
    return errors, document


def main() -> int:
    repository = Path(__file__).resolve().parents[1]
    errors, _ = validate_repository(repository)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("migration ledger and direct-provider bypass inventory are current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
