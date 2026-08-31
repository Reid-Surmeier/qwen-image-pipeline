# Run Record

- Purpose: Own the immutable request, durable attempt reservation, hash-chained events, write-once evidence, and replay-derived view for one application Run.
- Interface: `modules/run-record/index.ts`
- Errors: `modules/run-record/errors.ts`
- Acceptance: `modules/run-record/run-record.test.ts`

Run Record is the only production writer of Run evidence. `reserve` creates one durable attempt from a Planned Run, `record` applies a legal write-once operation, `load` verifies and replays authority, and `readEvidence` returns bytes only after their journal receipt and SHA-256 have replayed successfully. Production callers acquire the filesystem adapter through the Effect-valued `fileRunRecordLayer` constructor, then provide the resulting Layer; the storage writer and its Context tag stay inside the module. The filesystem adapter commits each extension as a write-once event frame before atomically materializing `events.jsonl`, so replay can finish an interrupted append without erasing a concurrent winner. A submission permit exists only in memory after the first durable submission-may-have-started event, rejects a second use, and is never recreated by reload.

After provider evidence, one or more generated outputs may be persisted under `outputs/`. A Run then opens a donor-choice checkpoint, records a human-selected SHA-256 that must name one of those persisted outputs, writes the separately hashed assembled output and canonical `assembly-report.json`, and finally writes ordered `checks.json`. Only the mandatory passed check order can advance the same Run to `verified_candidate`. Run Record does not call Generation, perform Assembly or Fidelity Checks, or declare subjective Approval.
