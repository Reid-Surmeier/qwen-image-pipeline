from __future__ import annotations

import re
import sys
from pathlib import Path


FIELD_PATTERN = re.compile(r"^- (Purpose|Interface|Errors|Acceptance): (.+)$", re.MULTILINE)


def render_module_map(repository: Path) -> str:
    rows: list[str] = []
    for document in sorted((repository / "modules").glob("*/MODULE.md")):
        text = document.read_text(encoding="utf-8")
        title = text.splitlines()[0].removeprefix("# ")
        fields = dict(FIELD_PATTERN.findall(text))
        rows.append(
            "| {title} | {purpose} | {interface} | {errors} | {acceptance} |".format(
                title=title,
                purpose=fields["Purpose"],
                interface=fields["Interface"],
                errors=fields["Errors"],
                acceptance=fields["Acceptance"],
            )
        )
    return "\n".join(
        (
            "# Module map",
            "",
            "<!-- Generated from modules/*/MODULE.md by scripts/generate_module_map.py. -->",
            "",
            "| Module | Purpose | Interface | Errors | Acceptance |",
            "| --- | --- | --- | --- | --- |",
            *rows,
            "",
            "The remaining Conductor-led modules named by Issue #17 are added by their implementation tickets; this map never claims an unimplemented module.",
            "",
        )
    )


def main() -> int:
    repository = Path(__file__).resolve().parents[1]
    rendered = render_module_map(repository)
    destination = repository / "MODULES.md"
    if len(sys.argv) == 2 and sys.argv[1] == "--check":
        if not destination.is_file() or destination.read_text(encoding="utf-8") != rendered:
            print("MODULES.md is stale; regenerate it from module documents", file=sys.stderr)
            return 1
        print("module map is current")
        return 0
    if len(sys.argv) == 2 and sys.argv[1] == "--write":
        destination.write_text(rendered, encoding="utf-8")
        return 0
    print("usage: generate_module_map.py --check|--write", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
