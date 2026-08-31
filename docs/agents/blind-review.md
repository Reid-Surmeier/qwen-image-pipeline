# Blind artifact review

Use this gate when a ticket creates or changes a visual or interactive application candidate. A governance diagram that only explains non-visual repository work is pull-request evidence, not an application candidate, and does not trigger this gate.

## Review packet

The application repository owns a write-once packet that identifies:

- the acceptance contract and unresolved subjective questions;
- every authoritative reference by application-relative path and SHA-256;
- the candidate artifact and exact tool/application commit identities;
- deterministic check results and launch/reset instructions.

The packet must validate before review. A changed candidate, reference, contract, or commit invalidates the verdict.

## Reviewer contract

Use a fresh reviewer that receives only the packet. The reviewer judges the artifact against the contract, does not receive the implementer's narrative, and never modifies the candidate. Each finding records expected behavior, actual behavior, evidence, and the violated clause. The verdict is pass, fail, or blocked and always names the reviewed hashes and commits.

Blind review is independent evidence. It cannot waive a failed deterministic check and does not replace the application owner's subjective final approval.
