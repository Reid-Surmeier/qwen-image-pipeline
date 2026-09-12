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

`main` is release-only. Ruleset `21881100` requires a pull request, the GitHub Actions `release-train` status, and a successful deployment to the `release-train` environment; it refuses deletion and force pushes and gives no GitHub Actions bypass. The environment accepts only `v*` tag refs. Tag ruleset `21882710` lets only the repository owner create, move, or delete those version tags. A lookalike branch workflow can therefore copy a check name but cannot provide the required deployment or qualifying ref. The repository owner is the one explicit recovery bypass.

A version becomes a release only after the qualifying ticket proves the whole build, the owner makes any named decision, and fresh Standards and Specification reviewers each post their exact-SHA verdict as a repository Issue comment. Each comment has exactly one `review-axis`, `reviewer-id`, `reviewed`, and `verdict` marker. The canonical JSON receipt names both distinct comments and their SHA-256 hashes; GitHub must authenticate both comments as owner records, and both must say `ship` for the same exact SHA. Keep that receipt outside the candidate tree and run `scripts/release_steward.py cut <version> --review-file <receipt>` from the clean pushed `build/v<version>` line. It reruns the deterministic baseline, embeds the canonical receipt in the annotated tag, and pushes only that tag. `verify-tag` reads the receipt from the immutable tag and re-authenticates both hash-locked comments. This avoids the impossible claim that a committed review file contains its own commit SHA and prevents a free-form local file from declaring itself reviewed.

The owner-only tag starts both Release train and Release. Release train binds the required status and required tag-only deployment to the tag, exact review, and exact open build PR. Release revalidates the evidence, runs Verify without provider credentials or paid effects, polls the exact tag commit until the GitHub Actions `release-train` check exists and succeeds, and uses GitHub's head-commit match when merging through protected `main`. GitHub then also enforces the environment deployment before accepting the merge. Release publishes `RELEASE.md` as the GitHub Release. A missing, malformed, unauthenticated, held, or stale review; malformed version; lightweight tag; dirty tree; unpushed tip; gate failure; conflicting tag; or existing tag with different receipt refuses the cut.

The exact ruleset create request and GitHub's returned record are in [`docs/releases/v0.3.0/`](../releases/v0.3.0/main-protection.md).

## 5. Keep ownership clear

Tool releases contain reusable code and procedure documentation. Application repositories pin a compatible tool version and retain their Project Contracts, references, run directories, outputs, hashes, provenance, and final human approvals. Cross-repository evidence is linked by immutable identity, not copied into the tool repository as miscellaneous examples.
