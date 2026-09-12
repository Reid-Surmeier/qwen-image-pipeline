# Testing interface

Status: frozen by Issue #18.

## Public operation

`scripts/verify.sh` runs the whole deterministic repository baseline and returns exit code `0` only when every named check passes. It accepts no credential, provider, model, or spend arguments.

`scripts/run_deterministic_command.py` is its internal process-isolation adapter. Its Python functions are exposed only as an acceptance seam for the Testing module; application callers must not use them.

## Evidence

Standard output names every check and its result. GitHub Actions invokes the same operation from a clean environment. No generated application artifact is an output of this interface.

The trust root is the operating system launching the absolute `/usr/bin/env` and `/bin/bash` paths. `scripts/verify.sh` immediately re-enters with an empty environment; effects already performed by a hostile parent process or dynamic loader before the script starts are outside any child program's control and are not baseline evidence.
