# Testing

- Purpose: Prove the repository candidate through one deterministic, no-cost baseline.
- Interface: `modules/testing/interface.md`
- Errors: `modules/testing/errors.json`
- Acceptance: `tests/test_deterministic_baseline.py`, `tests/test_successor_governance.py`

Testing owns `scripts/verify.sh`, the deterministic command runner, isolation guards, and governance validation. The baseline pins FFmpeg major 6 at `/usr/bin/ffmpeg` and permits one exact stdin-only framehash invocation used by the three Seedance media gates to prove decoded dimensions, duration, and audio presence. The Node guard rejects changed arguments or environment, the native guard accepts only the same resolved executable and argument vector, and inherited seccomp still denies network syscalls. Every other unlisted descendant remains blocked. Testing may run exact local checks and safe read-only helpers; it never owns provider qualification or application approval.
