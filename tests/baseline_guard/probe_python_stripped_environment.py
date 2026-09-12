import subprocess
import sys
import os
from pathlib import Path


repository = Path(__file__).resolve().parents[2]
probes = (
    [sys.executable, repository / "tests" / "baseline_guard" / "probe_python_udp.py"],
    [
        os.environ["QWEN_BASELINE_NODE"],
        repository / "tests" / "baseline_guard" / "probe_node_udp.cjs",
    ],
)
for probe in probes:
    completed = subprocess.run(
        probe,
        env={"PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode == 0 or "network access is disabled" not in completed.stderr:
        raise SystemExit("approved descendant discarded the deterministic guard")
print("approved descendants preserve the deterministic guard")
