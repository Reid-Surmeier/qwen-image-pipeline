from __future__ import annotations

import json
import sys
from pathlib import Path


REQUIRED_TEXT = {
    "AGENTS.md": (
        "qwen-image-pipeline",
        "build/<version>",
        "needs-human-review",
        "Application repositories own",
        "scripts/verify.sh",
    ),
    "README.md": (
        "qwen-image-pipeline",
        "reusable tool",
        "application repositories",
        "build/v0.3.0",
    ),
    "docs/agents/repository-workflow.md": (
        "build/<version>",
        "needs-human-review",
        "tag",
        "application repositories",
    ),
    "docs/agents/triage-labels.md": (
        "needs-triage",
        "ready-for-agent",
        "needs-info",
        "blocked",
        "needs-human-review",
        "ready-for-human",
        "ready-to-fold",
        "folded-into-release",
        "not-a-release",
    ),
    ".github/pull_request_template.md": (
        "What is this build?",
        "Changelog",
        "What the owner decides",
    ),
}

FORBIDDEN_TEXT = {
    "AGENTS.md": {
        "release/v0.2.0": "AGENTS.md contains inherited release/v0.2.0 governance",
        "Godot Interactive Replica": "AGENTS.md contains inherited Godot application scope",
        "200 Qwen generations": "AGENTS.md contains an inherited application spend allowance",
    },
    "docs/agents/repository-workflow.md": {
        "Qwen-3-Pro-Pipeline": "repository workflow names the inherited repository",
        "one approval gate": "repository workflow retains the inherited PR approval gate",
    },
}

FORBIDDEN_BASELINE_COMMANDS = (
    "openrouter",
    "comfyui",
    "generate",
    "submit",
    "bws ",
    "curl ",
    "gh api",
)


def validate_repository(root: Path) -> list[str]:
    problems: list[str] = []
    contents: dict[str, str] = {}
    for relative, required in REQUIRED_TEXT.items():
        path = root / relative
        if not path.is_file():
            problems.append(f"missing governance file: {relative}")
            continue
        contents[relative] = path.read_text(encoding="utf-8")
        for phrase in required:
            if phrase not in contents[relative]:
                problems.append(f"{relative} is missing required governance phrase: {phrase}")

    for relative, forbidden in FORBIDDEN_TEXT.items():
        text = contents.get(relative)
        if text is None:
            path = root / relative
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8")
        for phrase, message in forbidden.items():
            if phrase in text:
                problems.append(message)

    workflow = root / ".github" / "workflows" / "verify.yml"
    if not workflow.is_file():
        problems.append("missing Verify workflow")
    else:
        workflow_text = workflow.read_text(encoding="utf-8")
        if "build/**" not in workflow_text:
            problems.append("Verify workflow does not run on build branches")
        if "scripts/verify.sh" not in workflow_text:
            problems.append("Verify workflow does not call the canonical baseline")

    verify = root / "scripts" / "verify.sh"
    if not verify.is_file():
        problems.append("missing canonical scripts/verify.sh baseline")
    else:
        verify_text = verify.read_text(encoding="utf-8")
        if "validate_successor_governance.py" not in verify_text:
            problems.append("canonical baseline omits successor governance validation")
        executable_lines = "\n".join(
            line.strip()
            for line in verify_text.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ).lower()
        for command in FORBIDDEN_BASELINE_COMMANDS:
            if command in executable_lines:
                problems.append(f"canonical baseline contains external or paid command: {command}")

    sweep = root / ".sandcastle" / "sweep.json"
    if not sweep.is_file():
        problems.append("missing Sandcastle sweep configuration")
    else:
        try:
            sweep_data = json.loads(sweep.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            problems.append("Sandcastle sweep configuration is invalid JSON")
        else:
            if sweep_data.get("verify") != ["scripts/verify.sh"]:
                problems.append("Sandcastle does not invoke the one canonical baseline")

    return problems


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    problems = validate_repository(root)
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}", file=sys.stderr)
        return 1
    print("successor governance contract is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
