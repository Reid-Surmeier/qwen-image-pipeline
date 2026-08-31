# Nano Banana 2 through OpenRouter (Issue #37)

Checked 2026-08-31 against public Google and OpenRouter sources. No credential
was read, no authenticated endpoint was called, and no generation or spend was
performed.

## Decision

Use OpenRouter's GA request model ID
`google/gemini-3.1-flash-image` through the dedicated synchronous
`POST https://openrouter.ai/api/v1/images` interface. Record the ID plus the
currently resolved permanent identity
`google/gemini-3.1-flash-image-20260528` in every immutable Run Request, and
refresh the public model and endpoint records before paid submission.

Do not use `google/gemini-3.1-flash-image-preview`. OpenRouter still lists the
preview as a distinct model, but Google records its 2026-06-25 shutdown and the
GA `gemini-3.1-flash-image` replacement. The preview therefore is neither an
acceptable alias nor a reproducibility pin
([Google deprecations](https://ai.google.dev/gemini-api/docs/deprecations),
[OpenRouter image models](https://openrouter.ai/api/v1/images/models)).
OpenRouter's general Models API currently maps the GA request ID to the dated
`canonical_slug`; its documentation defines `id` as the request identifier and
`canonical_slug` as the permanent identity
([Models documentation](https://openrouter.ai/docs/guides/overview/models),
[live GA model record](https://openrouter.ai/api/v1/model/google/gemini-3.1-flash-image)).

This is an additive model selection, not an automatic fallback. A Run Request
must name Nano Banana 2 explicitly. It must also name an allowed Google endpoint
explicitly and disable provider fallback to comply with the repository's
existing explicit-provider rule.

## Definitive OpenRouter Image API contract

OpenRouter says the per-endpoint image records are definitive and that a missing
capability key means the endpoint does not support that parameter
([image-generation guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)).
The current GA model entry and both endpoint records expose this contract:

| Field | Nano Banana 2 contract |
| --- | --- |
| Input/output modalities | text + image in; image + text at model level |
| Generation transport | buffered `POST /api/v1/images`; native streaming is false |
| `resolution` | exactly `512`, `1K`, `2K`, or `4K` |
| `aspect_ratio` | exactly `1:1`, `1:4`, `1:8`, `2:3`, `3:2`, `3:4`, `4:1`, `4:3`, `4:5`, `5:4`, `8:1`, `9:16`, `16:9`, or `21:9` |
| `n` | exactly 1 |
| `input_references` | 0 through 14 |
| `seed` | unsupported on the dedicated image endpoints |
| `size` / exact pixels | unsupported on the dedicated image endpoints |
| `output_format`, quality, background, compression | unsupported on the dedicated image endpoints |
| Provider passthrough | only `cachedContent` |

Sources: the live
[image-model entry](https://openrouter.ai/api/v1/images/models) and
[GA endpoint records](https://openrouter.ai/api/v1/images/models/google/gemini-3.1-flash-image/endpoints).
The generic Image API describes more request fields, but they are not thereby
enabled for every model. In particular, the general chat-model record advertises
`seed` while the definitive dedicated-image records do not. The adapter must
fail before submission for any absent endpoint capability rather than silently
discarding it or relying on the provider to ignore it.

OpenRouter currently exposes two otherwise capability-equivalent routes:

- Google Vertex: provider tag `google-vertex/global`.
- Google AI Studio: provider tag `google-ai-studio`.

The Image API accepts `provider.only`, `provider.order`, `provider.ignore`,
`provider.sort`, and `provider.allow_fallbacks`. OpenRouter normally permits
provider failover, so an exact-provider request must use, for example,
`{"only":["google-ai-studio"],"allow_fallbacks":false}`. Selection between the
two routes remains a build-time policy decision; this research found no
capability or price distinction that decides it
([provider-routing contract](https://openrouter.ai/docs/guides/overview/multimodal/image-generation#provider-routing)).

## Request and response shapes

Text-to-image uses one non-empty prompt:

```json
{
  "model": "google/gemini-3.1-flash-image",
  "prompt": "<compiled Edit Brief>",
  "n": 1,
  "resolution": "1K",
  "aspect_ratio": "1:1",
  "provider": {
    "only": ["<explicit Google provider tag>"],
    "allow_fallbacks": false
  }
}
```

Reference-guided editing uses the same request with ordered references:

```json
{
  "input_references": [
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,<base64 bytes>"
      }
    }
  ]
}
```

An `image_url.url` may be an HTTP(S) URL or a base64 data URL. The generic API
permits 16 references, but this model's narrower record caps the request at 14.
OpenRouter does not publish a model-specific reference MIME allowlist or byte
limit; its API reference only documents `413 Request payload too large`. PNG
and JPEG appear in Google's native examples, but that is not proof of the
normalized OpenRouter input contract. Until live qualification proves more, a
local adapter must not claim additional formats or provider byte limits
([OpenRouter API reference](https://openrouter.ai/docs/api/api-reference/images/generate-an-image),
[Google image guide](https://ai.google.dev/gemini-api/docs/image-generation)).

A buffered success has this normalized shape:

```json
{
  "created": 1748372400,
  "data": [
    {
      "b64_json": "<base64 image bytes>",
      "media_type": "image/png"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 1120,
    "total_tokens": 1120,
    "cost": 0.067
  }
}
```

`data[0].b64_json` is the one expected output. `media_type` is present when
OpenRouter can identify the format and may otherwise be absent; `usage` reports
token counts and exact USD cost when available. The adapter must strictly
base64-decode one item, validate the detected media, hash the stored bytes, and
preserve the raw response. Because output-format control is absent from this
model's endpoint record, the adapter must accept and record the returned media
type rather than promise PNG
([response contract](https://openrouter.ai/docs/guides/overview/multimodal/image-generation#response-format)).

The documented success object has no request ID, resolved model, or resolved
provider field. Exact provenance must therefore include the locally assigned
Run identity, canonical request digest, selected provider tag, request and
response timestamps, raw response, capability-snapshot identity, and output
hash. A provider configuration that allows failover cannot prove which route
served the image from this response shape alone.

## Pricing and count behavior

Both OpenRouter endpoint records currently charge `$0.00006` per output-image
token. The model page also lists `$0.50` per million input tokens, `$3` per
million text/thinking output tokens, `$60` per million image-output tokens, and
`$14` per 1,000 web searches
([OpenRouter model page](https://openrouter.ai/google/gemini-3.1-flash-image)).
Google's current standard image-output equivalents are:

| Resolution | Image tokens | Image-output cost |
| --- | ---: | ---: |
| `512` | 747 | $0.045 |
| `1K` | 1,120 | $0.067 |
| `2K` | 1,680 | $0.101 |
| `4K` | 2,520 | $0.151 |

These are pre-submission estimates; the Run Record must use OpenRouter's actual
`usage.cost` when exposed and retain input/thinking costs separately
([Google pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-image)).
`n` is fixed at one for both current OpenRouter endpoints, so one request can
reserve at most one output. Multiple candidates require separate Planned Runs;
they are not a hidden retry or multi-image batch.

## Google-native capabilities that OpenRouter does not expose here

Google's GA model accepts text, image, and PDF natively, has a 131,072-token
input limit and 32,768-token output limit, and supports image generation,
Search grounding, and Thinking. Google also documents video-to-image input,
conversational editing through interaction state, 14 total references, fidelity
guidance for up to 10 objects and four characters, and mandatory SynthID on
generated images
([model card](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image),
[image guide](https://ai.google.dev/gemini-api/docs/image-generation)).

The normalized OpenRouter Image API does not document PDF/video references,
Google Search or Image Search tools, multi-turn interaction IDs, thought images,
or mixed text-and-image response steps for this model. It translates the native
`input` blocks and `response_format` into `prompt`, `input_references`,
`resolution`, and `aspect_ratio`, then returns base64 images in `data`. Those
Google-only features are outside this adapter contract unless a later endpoint
record explicitly exposes them.

Google specifies default 1K generation, output-size matching for an edit when
no ratio is supplied, and exact native pixel tables for every ratio/tier.
OpenRouter instead says concrete pixels are derived per provider. The local
adapter should record requested tier/ratio and measured returned dimensions;
it should not claim native pixel dimensions as an OpenRouter guarantee before
live qualification.

## Timeout, billing, and no-blind-retry consequence

The current model is non-streaming and OpenRouter's Image API returns one
buffered response; no asynchronous image job, polling identity, service timeout
SLA, or idempotency key is documented. The API documents error statuses
including 502 and 524. Its billing guide says completed images are billed in
full while failed or cancelled generations are not billed
([billing contract](https://openrouter.ai/docs/guides/overview/multimodal/image-generation#billing-and-cancellation),
[error shapes](https://openrouter.ai/docs/api/api-reference/images/generate-an-image)).

That claim does not make a client timeout or lost response safe to resubmit: the
client may not possess the explicit terminal response, and the API provides no
request ID or idempotency token with which to prove that a second submission is
the same work. The repository's stricter rule therefore controls. Persist the
Attempt Reservation and submission-may-have-started event before I/O; classify
a transport timeout, malformed success, decode failure, or interrupted
post-submit persistence as possibly spent; preserve it for reconciliation; and
never submit it again blindly. OpenRouter's 524 text saying to try again later
is not authorization to bypass that rule.

## Implementation constraints established by this research

1. Configure Nano Banana 2 by explicit model ID, with its observed canonical
   identity and endpoint capability snapshot recorded in the Run Request.
2. Compile generation and ordered-reference editing into the dedicated Image
   API; preflight exactly one output, 0-14 references, the four resolution tiers,
   and the 14 ratios before reserving spend.
3. Reject unsupported controls including seed, explicit-pixel `size`, output
   format, quality, background, and compression for the current endpoints.
4. Require one explicit Google provider tag with fallback disabled, then record
   actual `usage.cost`, returned media/dimensions, hashes, and the raw response.
5. Keep preview, chat-completions image output, native Google Interactions,
   search grounding, multi-turn editing, PDF/video input, and asynchronous batch
   work outside this first adapter.

## Remaining evidence boundary

Public discovery confirms the current contract, not the active credential or
the real response details. The separately authorized qualification should make
exactly two smallest-useful paid Planned Runs after no-cost contract tests: one
text-to-image and one single-reference edit. It must pre-record provider, model,
count, estimate, stop rule, and request digest; preserve raw headers/body and
actual cost; and perform no retry after an ambiguous result. That later evidence
can decide the explicit Google provider and establish the real returned MIME,
dimensions, timing, and any response headers absent from the public schema.
