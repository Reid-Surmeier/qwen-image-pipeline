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
        "scripts/release_steward.py",
        "21881100",
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
        "release-train",
        "21881100",
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
    "MODULES.md": (
        "Generated from modules/*/MODULE.md",
        "| Review |",
        "| Testing |",
    ),
}

FORBIDDEN_TEXT = {
    "AGENTS.md": {
        "release/v0.2.0": "AGENTS.md contains inherited release/v0.2.0 governance",
        "Godot Interactive Replica": "AGENTS.md contains inherited Godot application scope",
        "200 Qwen generations": "AGENTS.md contains an inherited application spend allowance",
        "Ticket #19 must install": "AGENTS.md still says release enforcement is pending",
    },
    "docs/agents/repository-workflow.md": {
        "Qwen-3-Pro-Pipeline": "repository workflow names the inherited repository",
        "one approval gate": "repository workflow retains the inherited PR approval gate",
        "Until #19 is complete": "repository workflow still says release enforcement is pending",
    },
}

FORBIDDEN_BASELINE_COMMANDS = (
    "openrouter",
    "comfyui",
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
        workflow_lines = workflow_text.splitlines()
        try:
            verify_start = workflow_lines.index("  verify:")
        except ValueError:
            verify_lines: list[str] = []
        else:
            verify_end = next(
                (
                    index
                    for index in range(verify_start + 1, len(workflow_lines))
                    if workflow_lines[index].startswith("  ")
                    and not workflow_lines[index].startswith("    ")
                    and workflow_lines[index].rstrip().endswith(":")
                ),
                len(workflow_lines),
            )
            verify_lines = workflow_lines[verify_start:verify_end]
        if "build/**" not in workflow_text:
            problems.append("Verify workflow does not run on build branches")
        if "scripts/verify.sh" not in workflow_text:
            problems.append("Verify workflow does not call the canonical baseline")
        if verify_lines.count("    runs-on: ubuntu-24.04") != 1:
            problems.append("Verify workflow does not pin the FFmpeg 6 runner image")
        expected_ffmpeg_step = [
            "      - name: Install the FFmpeg 6 prerequisite",
            "        run: |",
            "          sudo apt-get update",
            "          sudo apt-get install --yes --no-install-recommends ffmpeg",
        ]
        ffmpeg_step_valid = False
        for index, line in enumerate(verify_lines):
            if line != expected_ffmpeg_step[0]:
                continue
            end = next(
                (
                    candidate
                    for candidate in range(index + 1, len(verify_lines))
                    if verify_lines[candidate].startswith("      - ")
                ),
                len(verify_lines),
            )
            ffmpeg_step_valid = [item for item in verify_lines[index:end] if item.strip()] == expected_ffmpeg_step
            break
        if not ffmpeg_step_valid:
            problems.append("Verify workflow does not install the FFmpeg 6 prerequisite")

    verify = root / "scripts" / "verify.sh"
    if not verify.is_file():
        problems.append("missing canonical scripts/verify.sh baseline")
    else:
        verify_text = verify.read_text(encoding="utf-8")
        if "validate_successor_governance.py" not in verify_text:
            problems.append("canonical baseline omits successor governance validation")
        if "run_deterministic_command.py" not in verify_text:
            problems.append("canonical baseline omits the deterministic command runner")
        if "VERIFY_PYTHON" in verify_text:
            problems.append("canonical baseline permits an environment-selected executable")
        if "PYTHON_BIN=/usr/bin/python3.12" not in verify_text:
            problems.append("canonical baseline does not pin its bootstrap interpreter")
        if not verify_text.startswith("#!/bin/bash\n"):
            problems.append("canonical baseline does not pin its shell interpreter")
        if "export PATH=/usr/bin:/bin" not in verify_text:
            problems.append("canonical baseline does not replace caller PATH")
        if "exec /usr/bin/env -i QWEN_BASELINE_CLEAN_BOOTSTRAP=1" not in verify_text:
            problems.append("canonical baseline does not re-enter from a clean environment")
        command_lines = [
            line.strip()
            for line in verify_text.splitlines()
            if line.strip().startswith("run_check ")
        ]
        if any('${DETERMINISTIC_RUNNER[@]}' not in line for line in command_lines):
            problems.append("a canonical baseline check bypasses the deterministic runner")
        executable_lines = "\n".join(
            line.strip()
            for line in verify_text.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ).lower()
        for command in FORBIDDEN_BASELINE_COMMANDS:
            if command in executable_lines:
                problems.append(f"canonical baseline contains external or paid command: {command}")

    for relative in (
        "scripts/run_deterministic_command.py",
        "scripts/generate_module_map.py",
        "modules/testing/MODULE.md",
        "modules/testing/interface.md",
        "modules/testing/errors.json",
        "modules/review/MODULE.md",
        "modules/review/interface.md",
        "modules/review/errors.json",
        "tests/baseline_guard/no_external_effects.c",
        "tests/baseline_guard/sitecustomize.py",
        "tests/baseline_guard/no_external_effects.cjs",
    ):
        if not (root / relative).is_file():
            problems.append(f"missing deterministic baseline guard: {relative}")

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
