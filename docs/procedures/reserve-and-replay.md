# Reserve and replay one Run

Use this procedure after `Conductor.plan` returns a Planned Run and before any adapter could submit provider work. The application repository supplies the durable artifact root; the tool repository receives no application evidence.

## 1. Reserve

Call `Run Record.reserve` with the unchanged Planned Run, sanitized payload SHA-256, estimated maximum cost, maximum count, and maximum spend. These values must exactly match the immutable request.

Done when `reserve` returns a `reserved` view and the application Run directory contains a hash-verified `request.json`, a genesis `events.jsonl` event, `state.json`, and `outputs/`.

## 2. Mark submission

Call `Run Record.record` with `SubmissionMayHaveStarted`. The module appends and synchronizes that event before returning the in-process Submission Permit.

Pass that permit to the adapter once. A replayed operation returns the current view without a permit. A different submission operation returns `DUPLICATE_SUBMISSION_BLOCKED` and the existing attempt must be reconciled.

Done when the adapter has either returned sanitized evidence or the Run view says `possibly_spent / reconcile-only`.

## 3. Record evidence

Hash the sanitized provider response bytes and call `Run Record.record` with `CommitProviderEvidence`. Run Record creates `provider-response.json` without replacement, synchronizes it, appends its receipt event, and derives the new view from replay.

Done when `load` returns `provider_evidence_received` and the evidence receipt matches the application file byte-for-byte.

## 4. Resume by replay

Create a fresh filesystem adapter for the same application root and call `Run Record.load(runId)`. Authority is evaluated in this order:

1. immutable `request.json` bytes;
2. the complete SHA-256 chain in `events.jsonl`;
3. write-once evidence bytes named by those events;
4. the derived `state.json` view.

A missing or changed authority produces a named integrity error. A derived view that claims the current event head but disagrees with replay produces `DERIVED_VIEW_CONTRADICTION`.

## Interruption outcomes

| Last durable fact | Safe continuation |
| --- | --- |
| No Run directory | Reserve the first attempt. |
| Attempt Reservation only | Record the first submission marker, then use its one permit. |
| Submission marker, no evidence | Reconcile the existing attempt identity. |
| Evidence file without its event | Replay the exact evidence operation or reconcile; keep the existing submission. |
| Evidence receipt event | Reload and continue from recorded evidence. |
| Definitive pre-submit failure | Plan and reserve a new Run linked to that exact failure event. |

Every row preserves the existing Run. None turns uncertainty into another submission.
