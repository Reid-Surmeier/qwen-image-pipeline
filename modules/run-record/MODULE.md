# Run Record

- Purpose: Record immutable requests, append-only chained events, durable attempt reservations, and write-once evidence for application runs.
- Interface: `modules/run-record/index.ts`
- Errors: `modules/run-record/errors.ts`
- Acceptance: `modules/run-record/run-record.test.ts`

Run Record is the sole production writer of application run records. It enforces durable pre-submit attempt reservation, chained event logs, write-once evidence, and tamper detection.
