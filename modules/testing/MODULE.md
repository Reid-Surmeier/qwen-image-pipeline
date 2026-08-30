# Testing

- Purpose: Prove the repository candidate through one deterministic, no-cost baseline.
- Interface: `modules/testing/interface.md`
- Errors: `modules/testing/errors.json`
- Acceptance: `tests/test_deterministic_baseline.py`, `tests/test_successor_governance.py`

Testing owns `scripts/verify.sh`, the deterministic command runner, isolation guards, and governance validation. It may run exact local checks and safe read-only helpers; it never owns provider qualification or application approval.
