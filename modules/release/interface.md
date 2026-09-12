# Release interface

Status: frozen by Issue #19.

## Public operations

- `evaluate_release(evidence)` returns an allowed `v<version>` tag or a
  classified refusal. Evidence names the build branch, local and pushed tip,
  release page, strict two-axis review receipt, authenticated GitHub evidence,
  reviewed SHA, and tree state. Standards and Specification use distinct
  reviewers and hash-locked owner Issue comments. The reviewed SHA must equal
  the candidate exactly; no successor commit is exempt.
- `cut_release(evidence, git, gates, dry_run)` evaluates first, runs the
  deterministic gates, and may create and push only the allowed annotated tag.
  The tag annotation embeds the canonical exact-SHA Standards and Spec ship receipt, so
  the receipt can name the candidate without changing that commit. It never
  pushes a branch and never updates `main`. An existing local or remote tag is
  accepted only when its complete annotated tag object carries that same receipt.
- `plan_cleanup(state)` returns a deterministic, read-only steward plan. The
  open `build/*` line, `capture/*`, `prototype/*`, `evidence/*`, `review/*`, and
  every dirty worktree are always kept.
- `.github/workflows/release-train.yml` emits the required status only for an
  annotated `v<version>` tag with current exact-SHA ship evidence and exactly
  one matching open build PR. The job also records the required
  `release-train` deployment, whose environment accepts only protected `v*`
  tag refs. A separate owner-only tag ruleset refuses creation, movement, or
  deletion of those refs by ordinary contents writers. `.github/workflows/release.yml` revalidates tag
  evidence, runs Verify, polls the exact tag commit until that required GitHub
  Actions check exists and succeeds, and merges only the
  head SHA it already matched through GitHub's protected-branch path.

## Results

Release refusal codes are frozen in `errors.json`. An allowed decision names
one immutable annotated tag and one exact target SHA. Dry-run output is stable
for the same observed state and performs no fetch, ref update, prune, deletion,
or worktree removal. Every checked-out branch is active evidence; named
evidence prefixes remain protected even when they have no worktree.

The command adapter accepts the fresh independent receipt through
`--review-file`; the file is outside the candidate tree. `verify-tag` reads the
same receipt back from the immutable tag annotation. A committed review file
cannot claim its own commit SHA and is not used as an exact-SHA shortcut.

The live `main` ruleset is repository state, not an inference from Markdown.
Its captured identity and complete configuration live under
`docs/releases/v0.3.0/` and are checked against GitHub before Issue #19 closes.
