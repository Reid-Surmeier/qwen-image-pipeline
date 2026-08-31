# Review interface

Status: extended and frozen by Issue #26.

## Public operations

- Review an exact commit independently against repository standards and the authoritative Issue.
- For a visual or interactive application candidate, review a hash-locked packet using [`docs/agents/blind-review.md`](../../docs/agents/blind-review.md).
- Prepare a hash-locked packet only after deterministic gates pass, and invalidate it if the exact Run Request, candidate, or references change.

## Results

Standards and Specification findings remain separate. A blind artifact verdict is `pass`, `fail`, or `blocked` and names the exact candidate and reference hashes. Review evidence never substitutes for subjective application-owner Approval.

The application packet names its acceptance contract, immutable Run Request, references, candidate, hashes, review instructions, deterministic verification evidence, and unresolved human decisions. Machine verification and owner Approval are separate fields. Packet preparation has no provider, credential, network, paid-review, Run Record writer, or Approval capability.
