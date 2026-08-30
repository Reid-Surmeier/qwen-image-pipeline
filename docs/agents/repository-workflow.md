# Repository workflow

Work moves from one authoritative Issue to the current `build/<version>` line, then to one reviewed tag and GitHub Release. The released tool is consumed by application repositories, which keep their own references, assets, runs, Assembly outputs, and builds.

## 1. Make the Issue executable

The Issue body is the work packet: outcome, scope, acceptance criteria, verification, and unresolved human decisions. Larger specs use native sub-issues and native blocked-by relationships. `ready-for-agent` means the ticket can be taken; `needs-info` or `blocked` means it cannot.

`needs-human-review` is a repository-level brake that only the owner applies. A runtime result of `human_decision_required` is separate: it records that the procedure reached a genuine subjective or product decision safely.

## 2. Work on the build line

Each version has exactly one `build/<version>` branch and one draft build pull request. Ticket work is tested and committed to that line; agents do not open owner-facing fragment pull requests. The build PR is the version changelog, CI surface, and visual evidence surface.

Every changelog line links its ticket and exact commit. A ticket closes only after its acceptance criteria pass on the build line and both specification and engineering reviews find no blocking defect.

## 3. Verify deterministically

Run `scripts/verify.sh` locally and in GitHub Actions. The baseline may inspect files and run deterministic tests; it must never submit paid generation, contact a provider, or require a secret. Provider qualification is explicit ticket-scoped evidence outside ordinary CI.

## 4. Release by tag

`main` is release-only. A version becomes a release only after the qualifying ticket proves the whole build, the owner makes any named decision, the build is represented by an immutable tag, and the GitHub Release carries the reviewed changelog and evidence.

Ticket #19 installs and tests the enforcement for this lifecycle. Until #19 is complete, agents must not claim that branch protection, tag-only release enforcement, or automated main reconciliation is active.

## 5. Keep ownership clear

Tool releases contain reusable code and procedure documentation. Application repositories pin a compatible tool version and retain their Project Contracts, references, run directories, outputs, hashes, provenance, and final human approvals. Cross-repository evidence is linked by immutable identity, not copied into the tool repository as miscellaneous examples.
