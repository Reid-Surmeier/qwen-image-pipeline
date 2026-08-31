# Run Record

- Purpose: Own the immutable request, durable attempt reservation, hash-chained events, write-once evidence, and replay-derived view for one application Run.
- Interface: `modules/run-record/index.ts`
- Errors: `modules/run-record/errors.ts`
- Acceptance: `modules/run-record/run-record.test.ts`

Run Record is the only production writer of Run evidence. `reserve` creates one durable attempt from a Planned Run, `record` applies a legal write-once operation, and `load` verifies and replays authority. Production callers acquire the filesystem adapter through the Effect-valued `fileRunRecordLayer` constructor, then provide the resulting Layer; the storage writer and its Context tag stay inside the module. The filesystem adapter commits each extension as a write-once event frame before atomically materializing `events.jsonl`, so replay can finish an interrupted append without erasing a concurrent winner. A submission permit exists only in memory after the first durable submission-may-have-started event, rejects a second use, and is never recreated by reload. Run Record does not call Generation or declare Approval.
