# Release interface

Status: frozen by Issue #19.

## Public operations

- `evaluate_release(evidence)` returns an allowed `v<version>` tag or a
  classified refusal. Evidence names the build branch, local and pushed tip,
  release page, review verdict, reviewed SHA, tree state, and any files in the
  one permitted evidence-only commit after review.
- `cut_release(evidence, git, gates, dry_run)` evaluates first, runs the
  deterministic gates, and may create and push only the allowed annotated tag.
  It never pushes a branch and never updates `main`.
- `plan_cleanup(state)` returns a deterministic, read-only steward plan. The
  open `build/*` line, `capture/*`, `prototype/*`, `evidence/*`, `review/*`, and
  every dirty worktree are always kept.
- `.github/workflows/release-train.yml` admits only the current build PR to the
  release path. `.github/workflows/release.yml` revalidates tag evidence, runs
  Verify, merges that exact build PR through GitHub's protected-branch path,
  and publishes its release page.

## Results

Release refusal codes are frozen in `errors.json`. An allowed decision names
one immutable tag and one exact target SHA. Dry-run output is stable for the
same observed state and has no write operation.

The live `main` ruleset is repository state, not an inference from Markdown.
Its captured identity and complete configuration live under
`docs/releases/v0.3.0/` and are checked against GitHub before Issue #19 closes.
