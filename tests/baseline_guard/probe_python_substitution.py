import subprocess
import sys
from pathlib import Path


fake_executable = Path(sys.argv[1])
kind = sys.argv[2]
repository = Path(__file__).resolve().parents[2]
if kind == "git":
    arguments = [fake_executable, "-C", repository, "rev-parse", "HEAD"]
elif kind == "node":
    arguments = [
        fake_executable,
        repository / "tests" / "baseline_guard" / "probe_node_network.cjs",
    ]
elif kind == "python":
    arguments = [
        fake_executable,
        repository / "tests" / "baseline_guard" / "probe_python_network.py",
    ]
else:
    raise SystemExit(f"unknown substitution kind: {kind}")

try:
    subprocess.run(arguments, check=False)
except PermissionError:
    print("substituted executable is disabled in the deterministic baseline")
else:
    raise SystemExit("substituted executable escaped the deterministic baseline")
