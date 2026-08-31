# Review

- Purpose: Bind independent review evidence to the exact candidate and contract.
- Interface: `modules/review/index.ts`, `modules/review/interface.md`
- Errors: `modules/review/errors.ts`, `modules/review/errors.json`
- Acceptance: `modules/review/review-packet.test.ts`, `tests/test_successor_governance.py`

Review owns the Standards/Specification review gate and the blind application-artifact review procedure. It prepares a hash-locked application packet only after Run Record replay proves a deterministic `verified_candidate`; caller-selected pass strings have no interface. The packet embeds the canonical Run Request, event head, tool/application commits, acceptance contract, references, replay-authenticated candidate and checks, instructions, and unresolved decisions. Validation rereads current application references and replays Run Record evidence, so changed bytes, contracts, commits, requests, events, candidates, or checks invalidate it. A caught reference mutation issues opaque counterevidence that Learning Promotion can authenticate. Review records evidence and verdicts; it cannot waive deterministic failures, call independent or paid semantic review, or create application Approval.
