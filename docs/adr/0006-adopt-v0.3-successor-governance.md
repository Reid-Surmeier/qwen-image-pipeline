# ADR 0006: Adopt v0.3 successor governance

- Status: Accepted
- Date: 2026-08-30
- Governing specification: GitHub Issue #17
- Supersedes: the Issue-readiness and single-PR-approval sections of ADR 0004, Move human approval to the pull-request gate

## Context

The repository inherited application-specific Godot scope, an obsolete release branch, and per-project spend language. That made the reusable tool appear to own application artifacts and left a new agent without a single dependable path from an application request to a trustworthy result or clear failure.

## Decision

This repository is the reusable `qwen-image-pipeline` tool. Application repositories own references, assets, generated media, deterministic Assembly outputs, run records, and builds.

Version work uses one `build/<version>` branch and one draft build pull request. The pull request is the changelog, CI, evidence, and owner review surface. `main` is release-only and reviewed versions are identified by immutable tags and GitHub Releases.

The repository distinguishes the owner-applied `needs-human-review` workflow brake from a procedure's `human_decision_required` result. The procedure should stop for genuine product decisions, not hidden implementation uncertainty.

`ready-for-agent` is again an implementation gate because the v0.3 specification and native dependency graph make readiness executable. Human approval is not required on every Issue; the owner can pause repository work only by applying `needs-human-review`. This supersedes ADR 0004 where it made `ready-for-agent` merely descriptive or made every pull request the approval gate. The one build pull request remains the whole-version review surface.

The deterministic baseline is `scripts/verify.sh` and cannot perform paid or external provider work.

## Consequences

Application examples and generated artifacts move to their owning repositories as later tickets migrate callers. Existing commands remain until their disposition is decided and tested.

Ticket #19 must implement and prove tag-only release enforcement and main protection. This record establishes the intended governance; it does not claim that enforcement already exists.
