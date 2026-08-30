# Issue 15: Seedance HTTP 400 diagnosis

## Conclusion

The original video reference was delivered to OpenRouter, but it was too small for
Seedance 2.0 Mini reference-to-video. It was 480 x 480, or 230,400 pixels. The provider
requires at least 407,696 input-video pixels for this model and mode.

The inherited client destroyed the original Run 001 response body, so that specific body
cannot be recovered and the run was not retried. The cause was isolated with additive,
single-POST probes that each retained the provider response and were never automatically
retried.

## Evidence chain

1. [Run 001](https://github.com/Reid-Surmeier/qwen-pipeline-experiments/tree/9ed4e00/artifacts/qwen-pipeline/runs/seedance-video-study-001-20260830T195347Z)
   sent the hash-locked 480 x 480 reference once. It retained only a generic HTTP 400
   because the inherited client called `raise_for_status()` and discarded the body.
2. [Run 002](https://github.com/Reid-Surmeier/qwen-pipeline-experiments/tree/162c0ab/artifacts/qwen-pipeline/runs/seedance-video-study-002-20260830T201500Z)
   embedded the exact same video as a `data:video/mp4` URL. The captured provider response
   said `input_references[0].video_url.url` accepts only HTTPS URLs.
3. [Run 003](https://github.com/Reid-Surmeier/qwen-pipeline-experiments/tree/f55e2c4/artifacts/qwen-pipeline/runs/seedance-video-study-003-20260830T201900Z)
   delivered those exact 480 x 480 bytes over HTTPS with `Content-Type: video/mp4`. The
   captured provider response identified the real constraint: the reference video must
   contain at least 407,696 pixels for `dreamina-seedance-2-0-mini` in `r2v` mode.
4. [Run 004](https://github.com/Reid-Surmeier/qwen-pipeline-experiments/tree/65ff7be/artifacts/qwen-pipeline/runs/seedance-video-study-004-20260830T202300Z)
   used a deterministic 720 x 720 derivative, or 518,400 pixels. The provider accepted and
   completed job `FOyiJ1KMir2CxbnqY6mB`, proving the corrected reference reached generation.

## Correction

The application repository owns both reference assets and their provenance:

- source SHA-256:
  `0f4ecfc3771d5e3e43709d7aaec7be7fac08b29f13c95e91eebe9b77b57f9ba2`;
- 720 x 720 derivative SHA-256:
  `8a0931d2876579dbb17e2ab3680d379516a59d9ec116a99f6a476964770f97a7`;
- deterministic procedure: Lanczos scale to 720 x 720, H.264 CRF 12 slow,
  `yuv420p`, no audio, and fast-start metadata;
- preflight now refuses a Seedance 2.0 Mini reference-to-video request below 407,696
  inspected pixels before a paid submission.

The correction is recorded in
[commit 9f93027](https://github.com/Reid-Surmeier/qwen-pipeline-experiments/commit/9f93027).

## Result classification and cost

Run 004 cost USD 0.064848 and returned output SHA-256
`815ed87ad79dc66a3dc5992b5b456739bfca8816d8b631c0e0e9967a78b1703f`.
The provider returned 640 x 640 despite the request contract specifying 480 x 480. The
deterministic verifier therefore classified it as `generated-check-failed` and
`output-contract-violation`; it is evidence that the input correction works, not an
approved or trustworthy visual result.

Runs 001 through 003 have no attributable actual cost. Each remains
`billing_status: possibly_spent`, and concurrent account usage makes balance deltas
insufficient evidence for assigning those failures a cost.

## Tool behavior required by this diagnosis

The OpenRouter client preserves a sanitized, capped provider error with safe response
identifiers. A failed submit is always `safe_to_retry: false` and
`billing_status: possibly_spent`. The CLI records the attempt immediately before the POST,
writes `provider-error.json` on an HTTP failure, and never retries implicitly.
