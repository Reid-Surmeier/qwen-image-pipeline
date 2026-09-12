# Release module

- Purpose: Turn one current independent build-line review into one immutable version tag and protected release.
- Interface: `modules/release/interface.md`
- Errors: `modules/release/errors.json`
- Acceptance: `tests/test_release_governance.py`

## Implementation

The local adapter is `scripts/release_steward.py`. GitHub adapters are
`.github/workflows/release-train.yml` and `.github/workflows/release.yml`.
Repository ruleset evidence is recorded with the release documents.

## Seams

The Release module depends on Testing only through `scripts/verify.sh` and on
Review only through the exact-SHA `REVIEW.md` record. It has no provider,
credential, model-runtime, application-artifact, or paid-review seam.
