# Run contract

Each paid request gets a fresh `runs/<UTC>-<slug>/` directory:

```text
brief.json                 human-readable source/style/motion contract
request.json               sanitized request and data-URL hashes
request.payload.json       ignored execution payload; may contain embedded assets
capabilities.json          selected live profile and canonical model slug
plan.json                  request hash, estimate, approval/submission flag
job.json                   resumable OpenRouter job identity
completed-job.json         terminal provider response
provider-error.json        sanitized structured HTTP failure when submission is rejected
inputs/                    optional copied source evidence
outputs/output.mp4         downloaded provider result
outputs/sha256.json        immutable output digest
verification/report.json   ffprobe, frame, anchor, and loop checks
```

The request payload is local and ignored because data URLs can be large or private. The sanitized
request remains inspectable. If the payload is lost, recreate it from the brief and locked sources;
do not reconstruct or guess a paid request from the sanitized record.

Before submission, the CLI recomputes `request_sha256`, re-fetches capabilities, and
refuses either a payload changed since planning or a changed canonical model version.
The exact decimal estimate must be provided to `--acknowledge-cost`. This gate documents
approval; it does not promise the provider invoice will equal the estimate.

`submit` constructs the credentialed client first, then marks the paid action as performed
immediately before sending the POST. A missing local credential therefore is not recorded as
a provider attempt, while a rejected POST is never represented as an unpaid plan. HTTP failures retain the operation,
status, endpoint, parsed provider error when the body is JSON, a size-capped sanitized
response body, and only allowlisted response identifiers. The cap is 64 KiB after UTF-8
encoding, redaction, and any invalid-byte replacement. Sensitive JSON fields and recognized
authorization, bearer, token, key, cookie, password, secret, and credential-URL forms are
redacted. Request headers are never written. A failed submission is classified
`billing_status: possibly_spent` and `safe_to_retry: false`; it is not retried by the
client.


## Strategy gate (enforced at plan time; owner instruction 2026-08-27)

After batch 3 of Issue #87 — the first certified complex-motion runs — the method that
produced it is enforced, fail-closed, in `plan` (`src/seedance_icons/strategy.py`).
A plan is refused unless:

1. **`era_idiom_basis`** cites the shipped-game behavior the motion imitates (≥ 8 words;
   see `research/era-ui-animation-reference-corpus.md`). Basis: batch 1 without it → 2 of
   4 structural failures; batch 2 with it → zero.
2. **`real_reference`** resolves to a real file: a reference animation built from actual
   game data (`evidence/board-icons-test/references/`, with provenance) or an explicit
   era-corpus doc citation when no redistributable frames exist.
3. The **compiled prompt is ≥ 350 words** — beat-by-beat, not the terse batch-1/2
   grammar (batch-3 certified cells ran 406–543 words).
4. **Both frame anchors are crisp**: local files, ≤ 32 unique non-matte colors, exact
   integer NEAREST blocks (batch 3 first-frame RMSE 4.0–4.3 vs 4.6–5.1 soft). Soft
   screenshot crops are refused by pixel inspection, not by filename.
5. **The actual motion reference is submitted** with `--video-reference HTTPS_URL`.
   Naming a clip in `real_reference` is provenance, not model input. When the clip is
   in the reference registry, its stable filename and `motion_kind` must match both the
   declaration and the URL that will be sent to OpenRouter.

`submit` independently refuses any plan whose `plan.json` lacks a passing (or explicitly
waived) `strategy_gate` record, so pre-gate plans cannot be submitted either.

The gate is profile-aware for sources outside game/pixel art. The brief declares
`"grammar"`: **`retro-sprite`** (the default when undeclared — the full rules above,
unchanged) or **`smooth`** (logos, brand marks, anti-aliased icons). Smooth briefs keep
the general principles — a `motion_basis` citation of the real-world behavior imitated,
a resolving `real_reference` (visible evidence, not a cited guess), the ≥ 350-word
prompt, and both anchors present as local files — but skip the crisp-pixel palette
check, which is a property of quantized pixel art only. An unrecognized grammar is a
violation: a run must say what kind of source it is.

Deliberate experiments remain possible — `--waive-strategy-gate "reason"` — but the
waiver is loud: the reason and the full violation list are stored in `plan.json` and
printed at plan time. There is no silent bypass.
