# The measured `meta/muse-image` capability record (Issue #46)

Compiled 2026-08-31. Every behavioural claim below is tagged **MEASURED** (a
run artifact in `Reid-Surmeier/qwen-pipeline-experiments`, branch
`bench/world-map-provider-switch`), **DOCUMENTED** (a live OpenRouter record or
docs page, cited), or **UNPROBED**. No generation was performed for this note
and no money was spent; every OpenRouter record cited here is a public,
unauthenticated GET, so no credential was read.

Where the raw run artifacts disagree with the prose that summarises them —
including the summary in map #45 — the artifacts win, and the disagreement is
called out.

## Decision

`meta/muse-image` cannot be admitted to this pipeline from provider metadata.
Its capability must be a **measured record, pinned in the repository, versioned
by the date it was measured** — because all three of OpenRouter's machine
records for this model are, today, either empty or describing a different kind
of model entirely. This is not a gap that a metadata refresh closes; two of the
three records are populated and *wrong*.

Send exactly four fields: `model`, `prompt`, `n`, and `size` (plus
`input_references` for an edit). Withhold `aspect_ratio`, `resolution`, `seed`,
`width` and `height`, and report each withheld field to the caller. Read the
output dimensions and the media type off the response; never assume them.

## Where provider metadata fails

Three OpenRouter records describe this model. They do not agree with each other
and none of them agrees with the wire.

| Record | What it says | Verdict |
| --- | --- | --- |
| `GET /api/v1/images/models/meta/muse-image/endpoints` | `{"id":"meta/muse-image","endpoints":[]}` | **Empty.** DOCUMENTED, re-fetched 2026-08-31. |
| `GET /api/v1/images/models` (the Muse entry) | `"supported_parameters": {}`, `"supports_streaming": false`, `input_modalities: [text, image]`, `output_modalities: [image]` | **Empty capability map.** DOCUMENTED. |
| `GET /api/v1/models/meta/muse-image/endpoints` (the *chat* Models API) | one populated endpoint — see below | **Populated and wrong for image use.** DOCUMENTED. |

The image-side records being empty is bad; the chat-side record being populated
is worse, because it is the one an implementer would find and believe:

```json
{"name":"Meta | meta/muse-image-1.0-eval-20260824","provider_name":"Meta","tag":"meta",
 "context_length":65536,"max_completion_tokens":58982,"quantization":"unknown",
 "pricing":{"prompt":"0","completion":"0","image_token":"0.00000239520958083832",
            "image_output":"0.00000239520958083832","discount":0},
 "supported_parameters":["max_tokens","repetition_penalty","top_k","temperature","top_p"],
 "supports_tool_choice":{"none":true,"auto":true,"required":true,"function":true},
 "uptime_last_1d":98.39}
```

Read against the wire, that record is wrong in four independent ways:

1. **Its five `supported_parameters` are all text-model parameters.** Not one of
   them exists on `POST /api/v1/images`. It advertises none of the three
   parameters Muse actually honors (`size`, `n`, `input_references`).
2. **`supports_tool_choice` is all-true** for a model with no tool surface on
   this endpoint.
3. **Its token pricing does not reproduce the bill.** At
   `$0.0000023952…/image token` the four measured runs would have cost
   $0.0125, $0.0044, $0.0104 and $0.0091. Every one was billed a flat **$0.01**
   (MEASURED — `usage.cost` in each `run.json`).
4. **`prompt`/`completion` priced at `"0"`**, which is not what a $0.01/image
   model charges.

OpenRouter's own image-generation guide says the per-endpoint records are the
definitive capability source and that *"an absent key means the parameter is
unsupported by that endpoint"*
([image-generation guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)).
Applied literally to Muse, that rule says the model supports **no parameters at
all** — including `prompt` and `size`, which are measurably honored, and
including the model's own existence as an image endpoint. **The documented rule
for reading capability is unusable for this model.** That, not the empty array
by itself, is the finding.

Two further doc-versus-wire contradictions on the human-facing model page
([openrouter.ai/meta/muse-image](https://openrouter.ai/meta/muse-image)):

- The page says Muse *"reasons before it renders, breaking down multi-part
  prompts and refining its output within the chain of thought."* MEASURED, the
  opposite: a single prompt carrying three instructions returned one of them
  (`runs/01-muse-size` removed the chrome but kept the time-zone banding and
  placed no capitals). Short single-purpose passes chained over the previous
  output are what work. `usage.completion_tokens_details.reasoning_tokens` is
  **0** on every recorded call, so whatever reasoning happens is neither
  reported nor separately billed.
- The page says *"Iterative editing works by passing the previous output image
  back with a new instruction."* MEASURED and confirmed — that is exactly the
  procedure that produced the finished map.

The model was created **2026-08-26** (`created: 1787764532`), five days before
these measurements. A new model with an unpopulated image-endpoint record is a
predictable state, and a capability standard has to survive it rather than wait
it out.

## The measured field contract

Every row is from `POST https://openrouter.ai/api/v1/images`, model
`meta/muse-image`, 2026-08-31.

| Field | Behaviour | Observed effect | Evidence |
| --- | --- | --- | --- |
| `model` | honored | — | every run |
| `prompt` | honored, **one instruction per pass** | a three-instruction prompt executed one instruction | MEASURED `runs/01-muse-size` vs `05-muse-pass2` + `06-muse-pass3` |
| `n` | **honored** | `n=2` returned 2 images and cost $0.02 | MEASURED `runs/00-contract-probe-summary.json`, case `n_2` |
| `size: "WxH"` | **honored as a ratio, not as pixels** | ratio held exactly; both sides scaled up to ~2.4–2.6 MP | MEASURED, 5 runs (below) |
| `aspect_ratio` | **accepted, then collapsed to 3 buckets** | `1:1`→1600x1600; `16:9`, `4:3`, `2:1`, `21:9` → **all** 1920x1280 (3:2); `9:16`, `3:4`→1280x1920 | MEASURED (probe summary covers `1:1`, `16:9`, `2:1`; the other four rows are attested by `BENCHMARK.md` prose only) |
| `resolution` | **accepted, ignored** | `1K` and `2K` at `2:1`/`16:9` both returned 1920x1280 | MEASURED, probe cases `ar_16_9_1K` and `ar_2_1_2K` |
| `seed` | **accepted, ignored** | seed 12345 sent twice → sha256 `2360223f7aad1096…` and `a9eea3a257dadebf…` | MEASURED, cases `seed_A` / `seed_A_again` |
| `width` / `height` | **accepted, ignored** | returned the bare default 1600x1600 | `BENCHMARK.md` prose; **not** in the documented request schema at all, so OpenRouter is discarding unknown keys silently |
| `input_references` | honored | a data-URL reference drove every edit pass | MEASURED, all edit runs |
| `provider` | never sent | — | UNPROBED |
| `output_format`, `quality`, `background`, `output_compression`, `stream`, `user` | never sent | — | UNPROBED |

**The silent-acceptance mechanism.** OpenRouter validates the body against one
shared schema for all image models, so `resolution`, `seed`, `aspect_ratio`,
`width` and `height` are all *valid* on this route; Muse then drops them. An
out-of-enum `aspect_ratio` returns a `ZodError` listing OpenRouter's shared enum
(`1:1 1:2 1:4 1:8 2:1 2:3 3:2 3:4 4:1 4:3 4:5 …`) — that enum is the gateway's,
and a value passing it says nothing about whether the model honors it. **There
is no error anywhere in this failure mode.**

Consequence: `aspect_ratio` is the wrong control for Muse. Asking for `16:9`
silently returns 3:2 — a 12% framing error the caller is never told about.
`size` must be sent **instead of**, not alongside, `aspect_ratio`; the API
reference states `size` *"cannot conflict with resolution/aspect_ratio"*
([API reference](https://openrouter.ai/docs/api/api-reference/images/generate-an-image)).

## Framing: bounds, step, and repeatability

Muse takes a **ratio contract**. It preserves the requested ratio exactly and
chooses its own pixel count.

| Requested `size` | Requested ratio | Returned | Returned ratio | Scale | Output MP |
| --- | --- | --- | --- | --- | --- |
| `2048x1024` | 2.0000 | **2240x1120** | 2.0000 | ×1.09375 | 2.51 |
| `1568x1568` | 1.0000 | **1600x1600** | 1.0000 | ×1.0204 | 2.56 |
| `1920x1080` | 1.7778 | **2048x1152** | 1.7778 | ×1.0667 | 2.36 |
| (none) | — | **1600x1600** | 1.0000 | — | 2.56 |

The first two rows are MEASURED with artifacts; the third is `BENCHMARK.md`
prose with no surviving per-case JSON.

Three properties fall out, and they are the useful ones:

1. **Ratio is exact.** All three requests returned the requested ratio to the
   digit. No silent rounding of the ratio itself.
2. **Every observed output dimension is a multiple of 32.** 2240, 1120, 1600,
   2048, 1152, 1920, 1280 — all divide by 32. So does every honored `size` that
   was sent. **The step is 32 on output** (MEASURED, 9 dimensions, 0
   exceptions). Whether a non-multiple-of-32 `size` is snapped or rejected is
   UNPROBED — one was never sent.
3. **Dimensions do not vary between calls at one ratio.** `size: "2048x1024"`
   was sent in three separate requests, minutes apart, with three different
   prompts and three different references; all three returned exactly
   2240x1120. `size: "1568x1568"` was sent twice and returned 1600x1600 twice.
   **The pixel choice is a deterministic function of the request, even though
   the pixel content is not** (MEASURED — `runs/01-muse-size`,
   `runs/05-muse-pass2`, `runs/06-muse-pass3`,
   `benchmarks/regional/runs/africa/{A-stripped,B-recoloured}`).

Every observed output lands between **2.36 and 2.56 MP**. The minimum and
maximum accepted `size`, and the behaviour of an extreme ratio such as `8:1`,
are UNPROBED.

**Muse is not reproducible.** `seed` is decoration: the same seed twice gives
different bytes. A Muse run can be *recorded* but never *replayed*. Qwen's seed
is real (see `docs/research/issue-53-seed-variance.md`); Muse's is not, and a
Run Record that stores it as if it were is recording a promise the provider
does not keep.

## References, count, and output media

- **Maximum references: UNPROBED.** Every recorded call sent exactly **one**
  reference. The generic API documents `input_references` `maxItems: 16`
  (DOCUMENTED); the model page advertises *"multi-image composition"* and
  *"reference-image conditioning … across a series"*, which implies more than
  one is accepted but names no ceiling. Muse's own limit is unknown. The
  prototype's `maxReferences: null` is the honest value and should stay null.
- **Reference media, MEASURED:** PNG, sent as a `data:` URL, at 323,785 B /
  1816x1816 and at 1,378,397 B / 2048x1043 — the largest reference that is
  known to have worked is **1.4 MB**. Chained passes fed back PNGs of up to
  1,455,518 B, also accepted. JPEG, WebP, HTTP(S) reference URLs, and the real
  byte ceiling are UNPROBED. OpenRouter documents only `413 Request payload too
  large` and publishes no per-model MIME allowlist or byte limit.
- **`n` ceiling: UNPROBED above 2.** `n=2` is MEASURED to work and to double
  the bill. The shared schema documents `1–10` and warns that *"providers may
  return fewer or reject n > 1"* (DOCUMENTED). Muse's real ceiling is unknown.
- **Output media type, MEASURED: `image/webp` on every single returned image**
  (8+ observations across both benchmarks). `output_format` was never sent. The
  adapter must record the returned media type, not promise PNG.
- **The success response cannot identify its own route.** Its keys are exactly
  `created`, `data`, `usage` — no request id, no resolved model, no provider
  field (MEASURED, every `response.json`). Provenance must come from the local
  Run Record.

## Provider route, identity, and who owns moderation

- **Route: Meta, direct. One provider, no alternatives.** DOCUMENTED — the
  model page says *"This model is hosted by one provider"* and names Meta; the
  chat endpoint record gives `provider_name: "Meta"` and `tag: "meta"` (the slug
  for `provider.only`). MEASURED corroboration: both refusal bodies carry
  `"metadata":{"provider_name":"Meta"}`.
- **Resolved endpoint identity: `meta/muse-image-1.0-eval-20260824`**
  (DOCUMENTED, from the chat endpoint record's `name`). This is the closest
  thing Muse has to a `canonical_slug` and is the string a Run Request should
  pin alongside `meta/muse-image`. Note `-eval-` in it.
- **Moderation is Meta's own, applied to the prompt, before generation.**
  MEASURED: `HTTP 400 {"error":{"message":"The response was filtered due to the
  prompt triggering our content management policy.","code":400,"metadata":
  {"provider_name":"Meta"}}}`. There is no OpenRouter-side moderation layer in
  evidence and none documented.
- Contrast, MEASURED: Qwen's only OpenRouter endpoint is Alibaba, and its
  refusal is `HTTP 400 "Alibaba blocked this request through content
  moderation."` with `provider_name: "Alibaba"`, returned after **253 s**.
  Different owner, different wording, two orders of magnitude different cost in
  wall-clock time.

## Pricing and `usage.cost`

- **`usage.cost` is reported, on every success.** MEASURED. It is a flat
  **$0.01 per image**, invariant across `image_tokens` of 1,814 / 1,816 / 3,789
  / 4,340 / 5,219 — a 2.9x spread in tokens at one price. `is_byok: false`.
  `cost_details.upstream_inference_cost` = 0.01,
  `upstream_inference_prompt_cost` = 0. This matches the human model page's
  "$0.01/image" and contradicts the machine record's per-token rate.
- **`n` multiplies it linearly**: `n=2` → `cost: 0.02` (MEASURED).
- **A refusal reports no cost.** Both filtered calls recorded `cost_usd: null`
  and `usage: {}` (MEASURED). OpenRouter documents billing as *"all-or-nothing …
  either completed and billed in full, or it fails and is not billed"*
  (DOCUMENTED). Whether the account ledger actually shows $0.00 for those
  attempts is UNPROBED — nobody read the activity page.
- Total spend that produced this entire record: **$0.19** ($0.16 of contract
  probes, $0.03 of map passes), plus the regional pilot's few cents.
- Note for the reader: the probe summary JSON accounts for 8 images ($0.08) of
  the $0.16 of probes. The other ~8 probe calls — the `4:3`, `21:9`, `9:16`,
  `3:4` buckets, the `1920x1080` size, and `width`/`height` — are attested by
  `BENCHMARK.md`'s prose and by the spend, but their per-case JSON is not in the
  repository. They are labelled accordingly above.

## Latency

MEASURED, wall clock from submit to parsed response, 2026-08-31.

| Shape | n | Range | Median |
| --- | ---: | --- | ---: |
| Text-to-image, no reference | 7 | **5.8 – 8.6 s** | 6.5 s |
| Reference-guided edit | 5 | **18.1 – 42.1 s** | 39.5 s |
| Moderation refusal | 2 | **4.0 – 8.1 s** | — |

Slowest Muse call ever observed: **42.1 s** (a 1.4 MB reference,
`runs/01-muse-size`). Compare Qwen at **253 s to return a refusal**. Latency
does not track output size — the 42.1 s and 18.1 s calls requested the same
`size` — it tracks how much the model changed.

This bears on the timeout rule. The pipeline's current 180 s default is too
short for Qwen and its failure mode costs money: the client gives up, the
provider finishes and bills anyway ($3.36 lost 2026-08-30, recorded in
`qwen_ui_pipeline/providers/openrouter.py`). A **600 s** ceiling clears the
worst observed case by 2.4x. For Muse alone, 120 s would be ~3x its worst
observed edit; a per-model ceiling is defensible on this evidence, a single
global one is only defensible at 600 s.

## Political-map content

**This section corrects the summary in map #45.** The world-map benchmark
recorded Muse completing political-map work 3 passes for 3, and that is true.
The regional pilot run two hours later shows it is not the whole behaviour.

| Content | Prompt | Outcome | s | Evidence |
| --- | --- | --- | ---: | --- |
| World map, borders, recolour + capitals | `recolour-v1` (long) | completed | 42.1 | `runs/01-muse-size` |
| World map, per-country recolour | `pass2-per-country` | completed | 18.1 | `runs/05-muse-pass2` |
| World map, capital labels | `pass3-capitals` | completed | 40.8 | `runs/06-muse-pass3` |
| Africa regional | 9-clause removal list | **filtered** | 8.1 | `regional/runs/africa/A-stripped` @ `ecc0cd8` |
| Africa regional | 2-sentence rewrite of the same request | completed | 39.5 | same path, working tree |
| Caribbean regional | that same 2-sentence prompt | **filtered, 3 attempts** | 4.0 | `regional/runs/caribbean/A-stripped` |
| Australia regional | that same 2-sentence prompt | **filtered** | ~6 | commit message of `ecc0cd8` and the `regional_batch.py` docstring — **no artifact** |

So, MEASURED:

1. **Muse does refuse political-map content.** The prototype's `refuses: []` for
   Muse is falsified. Its `refuses: ["political-map"]` for Qwen stands.
2. **The refusal is not deterministic and not content-determined.** The
   identical prompt passed on Africa and was filtered on Caribbean and
   Australia. Whatever the filter keys on, it is not "does this image contain
   national borders".
3. **Prompt length is a lever.** A nine-clause removal list was filtered on
   Africa where a two-sentence version of the same request went through. That is
   one paired observation, not a law.
4. **Refusal is cheap and early** — 4–8 s, before generation, no cost reported —
   which is why the experiments harness retries *only* the filter, up to three
   times, and treats any other failure as terminal
   (`scripts/regional_batch.py`). Three consecutive filtered attempts on the
   Caribbean show the retry does not always clear it.

The practical rule this supports: **Muse is usable for political-map content and
Qwen is not, but Muse's success on it is probabilistic.** A content class cannot
be modelled as a hard per-model gate for Muse the way it can for Qwen. It needs
a "may be refused, refusal is fast and free, bounded retry is legitimate"
representation — which is a third state the prototype's `refuses` list cannot
express.

## What the prototype's CAPABILITIES table gets right and wrong

Reviewing `qwen_ui_pipeline/providers/PROTOTYPE-capability-resolver.html` on
branch `prototype/model-capability-resolver` against the artifacts:

| Prototype claim | Verdict |
| --- | --- |
| `framing: "ratio"`, `framingField: "size"` | **Supported.** Ratio held exactly in 3/3 measured cases. |
| `targetPixels: 2.45e6` | **Close but slightly low.** Observed outputs 2.36–2.56 MP. As a *search target* for picking a `size` it is fine; as a prediction of returned pixels it must not be used — the resolver already says so. |
| `aspect_ratio: "coerced"`, `resolution/seed/width/height: "ignored"` | **Supported** by the probe summary and `BENCHMARK.md`. |
| `n: "honored"`, `input_references: "honored"`, `size: "honored"` | **Supported.** |
| `reproducible: false` | **Supported** — two calls, same seed, different sha256. |
| `maxReferences: null` | **Correct and should stay null.** Still unprobed. |
| `moderation: "Meta"` | **Now measured**, not merely asserted: `provider_name: "Meta"` in the refusal metadata. |
| `refuses: []` | **Wrong.** Muse filtered 3 of 4 recorded regional political-map attempts. |
| `slowestObserved: 42` | **Still correct** after 5 further calls. |
| `sizeForRatio()` snapping both sides to multiples of 32 | **Supported** — every observed output dimension is a multiple of 32, and the comment's reasoning (never snap sides independently, it silently changes the ratio) is exactly the failure the record exists to prevent. |
| `timeoutAdvice: max(600, slowest × 4)` | Defensible; 600 s is the binding term for Muse (42 × 4 = 168). |

The table's shape is right. It needs a fourth field status beyond
honored/coerced/ignored — **"may be refused"** — and it needs the record to
carry the date it was measured and the resolved endpoint identity
(`meta/muse-image-1.0-eval-20260824`), because a metadata-free model's contract
has no other way to be versioned.

## Implementation constraints established by this research

1. Pin Muse by `meta/muse-image` **plus** the resolved
   `meta/muse-image-1.0-eval-20260824` and the measurement date. Do not derive
   any capability from `/api/v1/images/models/**/endpoints` for this model; do
   not derive any from the chat-side record either.
2. Send `model`, `prompt`, `n`, `size`, and `input_references`. Withhold
   `aspect_ratio`, `resolution`, `seed`, `width`, `height` — and report each
   withheld field and what it cost the caller. Never send `size` alongside
   `aspect_ratio` or `resolution`.
3. Treat framing as a **ratio contract**: compute `size` from the ratio on the
   32-px grid, then read `width`/`height` and `media_type` off the response and
   resample locally if the caller needs exact pixels. Do not promise PNG; Muse
   returns WebP.
4. Record the run as unreplayable. No seed goes in the Run Record as if it were
   a recipe.
5. Model a Meta content filter as a fast, unbilled, non-deterministic 400 with
   a bounded retry — distinct from Alibaba's slow, absolute refusal.
6. Per-model timeout: 600 s ceiling; Muse's own worst case is 42 s.

## Unprobed

Every one of these is an output of this ticket, not a gap in it. Each line says
what would close it and roughly what that costs at $0.01/image.

| Fact | To close it | Cost |
| --- | --- | --- |
| Maximum `input_references` Muse accepts | binary search 2 → 4 → 8 → 16 references on a trivial prompt | ~4 calls, **$0.04** |
| Reference MIME allowlist (JPEG, WebP, GIF) and whether HTTP(S) reference URLs work | one call per format | ~4 calls, **$0.04** |
| Reference byte ceiling (largest known-good is 1.4 MB) | escalate 2 / 5 / 10 MB until 413 | ~3 calls, **$0.03**, plus billed successes |
| `n` ceiling above 2 | one call at `n=10` | 1 call, up to **$0.10** |
| Minimum and maximum accepted `size`; behaviour of a non-multiple-of-32 `size` (snapped or rejected?) | 3 calls: `32x32`, `4096x4096`, `1000x500` | 3 calls, **$0.03** |
| Whether an extreme ratio (`8:1`, `1:8`) is held or clamped | 2 calls | **$0.02** |
| Whether output dimensions are stable across *days*, not just minutes | repeat one probe later | **$0.01** |
| `output_format`, `quality`, `background`, `output_compression` — honored or ignored | 4 calls | **$0.04** |
| `stream: true` behaviour (docs say only OpenAI streams natively) | 1 call | **$0.01** |
| `provider: {"only":["meta"], "allow_fallbacks": false}` — accepted, and does it change anything | 1 call | **$0.01** |
| Whether the filtered 400s actually cost $0.00 on the account ledger | read the OpenRouter activity page for 2026-08-31 | **free, not yet done** |
| Whether the "web search for factual accuracy" the model page advertises ever fires, and whether it is billed separately | inspect `usage` on a knowledge-heavy prompt | **$0.01** |
| What the filter keys on (why Caribbean and Australia, not Africa) | a controlled prompt/content matrix | **$0.10+**, and may not converge |
| Whether the `4:3`, `21:9`, `9:16`, `3:4` bucket rows and the `1920x1080` size row are reproducible (their per-case JSON was not kept) | re-run the 5 probes with artifacts retained | 5 calls, **$0.05** |
| Whether the image-side endpoint record ever populates | re-fetch periodically | **free** |

Total to close everything mechanical: well under **$0.50**. The ticket forbids
spending it here; a separately authorised qualification run should, and should
record artifacts for every case rather than prose.

## Sources

**Measured** — `Reid-Surmeier/qwen-pipeline-experiments`, branch
`bench/world-map-provider-switch`, local clone `/home/reidsurmeier/qwen-pipeline-experiments`:

- `benchmarks/world-map/BENCHMARK.md`
- `benchmarks/world-map/runs/00-contract-probe-summary.json`
- `benchmarks/world-map/runs/{01-muse-size,02-qwen-2k,05-muse-pass2,06-muse-pass3}/{request,response,run}.json`
- `benchmarks/regional/runs/africa/{A-stripped,B-recoloured}/run.json` and
  `benchmarks/regional/runs/caribbean/A-stripped/run.json` — **uncommitted in
  the working tree at the time of writing**; the filtered Africa record is
  committed at `ecc0cd8`
- `scripts/bench_image_model.py`, `scripts/regional_batch.py`, `scripts/map_assemble.py`
- [qwen-pipeline-experiments#2](https://github.com/Reid-Surmeier/qwen-pipeline-experiments/issues/2) and its six revision comments

**Documented** — fetched unauthenticated 2026-08-31:

- <https://openrouter.ai/api/v1/images/models/meta/muse-image/endpoints>
- <https://openrouter.ai/api/v1/images/models>
- <https://openrouter.ai/api/v1/models/meta/muse-image/endpoints>
- <https://openrouter.ai/meta/muse-image>
- <https://openrouter.ai/docs/guides/overview/multimodal/image-generation>
- <https://openrouter.ai/docs/api/api-reference/images/generate-an-image>

**Repository context** — `qwen_ui_pipeline/providers/openrouter.py`,
`docs/research/issue-37-nano-banana-2-openrouter-contract.md`
(branch `research/37-nano-banana-contract`),
`docs/research/issue-53-seed-variance.md`,
`docs/research/issue-54-reference-count.md`,
`qwen_ui_pipeline/providers/PROTOTYPE-capability-resolver.html`
(branch `prototype/model-capability-resolver`, commit `837e6f1`).
