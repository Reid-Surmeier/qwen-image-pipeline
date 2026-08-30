import subprocess


try:
    subprocess.run(["curl", "--version"], check=False)
except PermissionError:
    print("descendant process is disabled in the deterministic baseline")
else:
    raise SystemExit("descendant process escaped the deterministic baseline")
