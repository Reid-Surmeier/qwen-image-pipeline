# Agent operating contract

This repository is `qwen-image-pipeline`: a reusable tool for planning, running, validating, and recording image and video generation procedures. Read the active Issue, this file, [`CONTEXT.md`](CONTEXT.md), applicable ADRs, and the nearest module documentation before changing files.

## Repository responsibility

Application repositories own application assets, references, generations, Assembly outputs, run records, and builds. This tool repository owns the reusable procedure, contracts, adapters, validators, and documentation that application agents invoke. Do not move application artifacts into this repository to make a test convenient.

The intended normal path is one documented procedure from an application repository that returns either a trustworthy classified result or a clear failure. Hidden rules in old Issues, experiment scripts, and Markdown comments are defects.

## Work readiness

An Issue may be implemented only when it has testable acceptance criteria, clear scope, a named verification method, the `ready-for-agent` label, and no `needs-triage`, `needs-info`, or `blocked` label. Use native sub-issues and blocked-by relationships for dependency order.

`needs-human-review` is an owner-applied repository brake. Agents never apply it. It is different from a procedure result of `human_decision_required`, which is expected when subjective final visual approval or another genuine product choice is needed.

## Build line

The owner reviews complete versions. Work for a version lands on one `build/<version>` branch and one draft build pull request. The current line is `build/v0.3.0`.

- Ticket work commits directly to the current build line after its acceptance checks pass.
- The draft build pull request is the human-readable changelog, CI surface, and visual evidence surface for the whole version.
- `main` is release-only. Agents do not merge the build pull request or create a release tag without the release ticket's explicit evidence and owner decision.
- Ticket #19 must install and prove the tag-only release enforcement before any v0.3.0 release is claimed.

## Preflight and change discipline

Before editing, run `git status --short --branch` and `git diff --check`. Confirm the checkout belongs to the active Issue, preserve unrelated work, and stop if a credential is present, accepted records conflict, or a material requirement is missing.

Write a failing acceptance test through the public interface before changing behavior when practical. Interface files, error types, and acceptance tests are frozen once accepted; changing one or moving a seam requires its own Issue. Make the smallest coherent change and document public behavior changes.

## Generation guardrails

- OpenRouter is the only paid provider route.
- Use the smallest useful batch and record the pre-submission decision before spending.
- Persist request identity, provider/model, inputs and hashes, seed, counts, timestamps, cost when exposed, output paths and hashes, raw provider errors, and retry safety.
- An ambiguous possibly billed request is counted as spent and is never retried blindly.
- A required reference must exist, match its recorded hash, and reach the exact provider request; otherwise refuse before submission.
- Generation is probabilistic. Assembly is deterministic. Existing authoritative pixels are assembled, not regenerated.
- Strict preservation requires a Fidelity Check with zero changed pixels outside declared edit regions when exact preservation is claimed.
- Ordinary CI and the canonical baseline never perform paid requests or external provider submissions.

## Verification and commits

Run the one deterministic baseline before committing and again on the integrated build line:

```bash
scripts/verify.sh
```

Report real results and distinguish inherited failures from introduced failures. Stage only intended files, keep commits coherent, use Conventional Commit subjects, and never invent Git identity.

## Pull request and review

The build pull request must link the governing spec, explain what the build is in plain language, maintain a changelog entry for every folded ticket, show visual proof when relevant, report exact verification, and state what the owner still decides.

Before a ticket is closed, review the exact candidate twice: specification fit and engineering standards. A visual or interactive artifact additionally requires the repository's blind artifact-review procedure. Machine verification is evidence; subjective final visual approval remains human.

## Stop conditions

Stop for a genuine unresolved human decision, conflicting authority, credentials, unapproved spend above the owner's allowance, ambiguous billing state, unverifiable exact preservation, an unsafe overwrite, missing Git identity, or contradictory verification. Do not pause for reversible unpaid work or for questions the repository and bounded tests can answer.

The complete lifecycle is in [`docs/agents/repository-workflow.md`](docs/agents/repository-workflow.md).
