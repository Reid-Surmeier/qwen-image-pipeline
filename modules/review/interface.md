# Review interface

Status: extended and frozen by Issue #26.

## Public operations

- Review an exact commit independently against repository standards and the authoritative Issue.
- For a visual or interactive application candidate, review a hash-locked packet using [`docs/agents/blind-review.md`](../../docs/agents/blind-review.md).
- Prepare a hash-locked packet only after deterministic gates pass, using a file-backed application repository snapshot for the exact application commit, contract, review brief, and references.
- Invalidate the packet if its complete shape, exact Run Request, repository commit, contract, review brief, candidate, references, checks, or Approval separation change.
- Catch a closed Review-owned deliberate-mutation kind only against a fully authenticated packet; Review maps the kind to its supported rule, affected seam, mutation description, and finding code, then binds the resulting counterevidence to its Run and packet.

## Results

Standards and Specification findings remain separate. A blind artifact verdict is `pass`, `fail`, or `blocked` and names the exact candidate and reference hashes. Review evidence never substitutes for subjective application-owner Approval.

The application packet names its acceptance contract, hash-locked application review brief, canonical immutable Run Request, Run event head, tool and repository-derived application commits, references, replay-authenticated candidate, review instructions, deterministic verification evidence, and unresolved human decisions. The application commit is accepted only when no-follow descriptor traversal resolves HEAD and its ref, then cryptographically verifies an existing loose or packed Git object whose exact identity and type are `commit`. Machine verification comes only from replaying a Run Record whose terminal classification is `verified_candidate`; it is never caller-selected. Validation re-derives the packet from the current rooted repository snapshot and replay-authenticates every Run-owned identity. Machine verification and owner Approval are separate fixed fields. Packet preparation has no provider, credential, network, paid-review, Run Record writer, or Approval capability.
