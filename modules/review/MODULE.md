# Review

- Purpose: Bind independent review evidence to the exact candidate and contract.
- Interface: `modules/review/index.ts`, `modules/review/interface.md`
- Errors: `modules/review/errors.ts`, `modules/review/errors.json`
- Acceptance: `modules/review/review-packet.test.ts`, `tests/test_successor_governance.py`

Review owns the Standards/Specification review gate and the blind application-artifact review procedure. It prepares a hash-locked application packet only after deterministic gates pass and invalidates it when the Run Request, candidate, or reference identity changes. It records evidence and verdicts; it cannot waive deterministic failures, call independent or paid semantic review, or create application Approval.
