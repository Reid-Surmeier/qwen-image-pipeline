# Testing

- Purpose: Prove the repository candidate through one deterministic, no-cost baseline.
- Interface: `modules/testing/interface.md`
- Errors: `modules/testing/errors.json`
- Acceptance: `tests/test_deterministic_baseline.py`, `tests/test_successor_governance.py`

Each public Seedance media gate performs the exact `/usr/bin/ffmpeg -version` probe itself and refuses any non-6 major. The deterministic baseline permits only that sanitized probe and the exact stdin-only framehash decode. Governance parses the active Verify job and requires the exact runner and FFmpeg install step; comments or conditional substitutes cannot satisfy it.

Testing owns `scripts/verify.sh`, the deterministic command runner, isolation guards, and governance validation. The baseline pins FFmpeg major 6 at `/usr/bin/ffmpeg` and permits one exact stdin-only framehash invocation used by the three Seedance media gates to prove decoded dimensions, duration, and audio presence. Local hosts provide that prerequisite; Verify pins Ubuntu 24.04 and installs its distribution package before entering the clean baseline, which independently refuses any non-6 major. The Node guard rejects changed arguments or environment, the native guard accepts only the same resolved executable and argument vector, and inherited seccomp still denies network syscalls. Every other unlisted descendant remains blocked. Testing may run exact local checks and safe read-only helpers; it never owns provider qualification or application approval.
