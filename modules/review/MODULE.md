# Review

- Purpose: Bind independent review evidence to the exact candidate and contract.
- Interface: `modules/review/interface.md`
- Errors: `modules/review/errors.json`
- Acceptance: `tests/test_successor_governance.py`

Review owns the Standards/Specification review gate and the blind application-artifact review procedure. It records evidence and verdicts; it cannot waive deterministic failures or create application Approval.
