# Issue 48: a measured capability resolver at the decided v0.4 Model Profile seam

Issue: [Research: fit a measured capability resolver onto the decided v0.4 Model Profile seam](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/48)

Checked 2026-08-31 against exact build commit
[`6f475bedbf51cd3e2a42c21574c4c61234a3a145`](https://github.com/Reid-Surmeier/qwen-image-pipeline/tree/6f475bedbf51cd3e2a42c21574c4c61234a3a145),
the live head of `origin/build/v0.3.0`. The Python tree under `qwen_ui_pipeline/`
is byte-identical on `origin/main` and `origin/build/v0.3.0` at this commit
(`git diff --stat origin/main origin/build/v0.3.0 -- qwen_ui_pipeline/` is empty),
so its line citations hold on either. No credential was read, no provider request
was made, no generation occurred, and no module, seam, or build branch was changed.

## Answer

**A per-field capability resolver is a planning-time function, not a transport
concern, and it is a seam change — but every seam it touches is already opened by
[#44](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/44) and
[#47](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/47).** Against
the frozen v0.3 interfaces it changes `run-contract`, `conductor`, `generation`,
`run-record`, and `provider-evidence-sanitizer`; against #47's already-planned v0.4
work it is additive in *placement* and a supersession in *content*, because #47's
Model Profile is entirely declared-metadata-shaped and has no vocabulary for a
measured claim, a per-field honored/coerced/ignored disposition, an unprobed field,
or a downgrade report.

**What Muse contradicts in #44 is exactly two clauses, and it breaks them in
opposite directions.** #44's drift machinery has two halves — *lock the bytes* and
*refresh and compare* — and only the second one fails for Muse. #44's field rule
has two halves — *never forwarded speculatively* and *never silently omitted* — and
Muse proves the first half is being violated by today's code while the second half,
read literally, would make Muse unusable.

The resolver is therefore not an exception to #44. It is the mechanism that makes
#44's own prohibition on speculative forwarding enforceable for the first time.

## The two contradictions, precisely

### 1. The drift authority: bytes survive, comparison does not

#44 says:

> A versioned repository Model Profile is the planning input. Immediately before
> planning a paid Run, the tool refreshes the relevant official OpenRouter model and
> endpoint records, canonicalizes them, and compares their identity and
> supported/absent controls with the profile.

`/api/v1/images/models/meta/muse-image/endpoints` returned an **empty endpoints
array** on 2026-08-31 ([#45](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/45),
measured evidence item 3; full record in
[qwen-pipeline-experiments#2](https://github.com/Reid-Surmeier/qwen-pipeline-experiments/issues/2)).

The refresh still *succeeds*. An empty array is a document; it canonicalizes and
hashes like any other. So #44's second clause survives untouched:

> The immutable Run Request locks the exact Model Profile bytes and digest.

What fails is the comparison. There is no advertised control set to compare a
profile's `supported and absent controls` against, so the comparison is vacuous.
That gives two bad outcomes and no good one:

- treat "absent from the record" as "capability absent" → every Muse control
  refuses and Muse can never be admitted;
- treat "nothing to compare" as "no drift" → the refresh becomes a no-op that
  stamps a fresh digest into the Run Record and thereby *manufactures an assurance
  of freshness that no evidence supports*. That is the worse failure, because it is
  silent and it is written into immutable evidence.

**Therefore #44's refresh-and-compare machinery needs a second mode, not a
loosening.** Inference, marked as such: the smallest honest shape is an explicit
**authority kind** on every capability claim — `declared` (from an endpoint record),
`measured` (from a recorded probe), `unprobed` — where drift-by-comparison is
defined only over `declared` claims, and the `measured` analogue of drift is
*staleness* (measurement age against a per-profile ceiling) plus *post-hoc
contradiction* (a response that contradicts a measured claim). #49 owns choosing
among those; this note only establishes that one mode cannot cover both.

### 2. The field rule: "never forwarded speculatively" already condemns today's code

#44 says:

> Unsupported fields are rejected explicitly. They are never silently omitted,
> forwarded speculatively, or replaced with a provider default. For the current Nano
> profile this includes seed, exact-pixel size, output format, quality, background,
> compression, and any output count other than one.

Muse splits this clause in half.

**The "forwarded speculatively" half stands and is load-bearing.** Today
`build_openrouter_request` sends `resolution`, `aspect_ratio`, `n`, and `seed`
unconditionally (`qwen_ui_pipeline/providers/openrouter.py:151-159`). Against Muse,
`resolution` and `seed` are accepted and ignored, and `aspect_ratio` is accepted and
collapsed to three buckets (#45, evidence item 3). Sending them is textbook
speculative forwarding, and #44 already forbids it. A withhold-and-report resolver
is the *compliant* implementation of this clause, not a departure from it.

**The "rejected explicitly" half is written at the wrong altitude.** It is a
*field*-level rule: an unsupported field refuses the Run. Read literally against
Muse, a caller asking for 16:9 gets a refusal, because `aspect_ratio` is not
honored. But the caller's *intent* — 16:9 framing — is fully satisfiable on Muse
through a different field, `size` (#45, evidence items 3 and 4). Refusing there
would be wrong.

**The sharpening #44 needs is a change of altitude: refusal is owed to an
unsatisfiable intent, withholding-with-a-report is owed to a field that cannot carry
a satisfiable one.** Seed on Muse refuses *reproducibility* (an intent nothing can
satisfy); `aspect_ratio` on Muse is withheld while *framing* is honored through
`size`. The prohibition that must survive verbatim is on **silent** omission — the
downgrade report is what makes the omission non-silent, and hashing it into the
immutable Run Request is what makes it non-repudiable.

Precedent already in the repo for the field-level shape, and for why it does not
generalize: ADR 0004 froze "OpenRouter rejects unsupported negative prompt, prompt
expansion, watermark, and size combinations before the shared adapter is called"
([`docs/adr/0004-add-partner-compatible-controls-beside-edit-brief-json.md`](../adr/0004-add-partner-compatible-controls-beside-edit-brief-json.md)),
implemented as flat rejects in `qwen_ui_pipeline/partner_controls.py:86-92`. Every
one of those is a field the *provider* rejects. None of them is a field the provider
accepts and the model ignores. Muse is the first case of the second kind, and the
existing pattern has no answer for it.

## Where the resolver sits: planning, not transport

#44 decided:

> Use one generic OpenRouter image transport with injected, locked Model Profiles,
> not one HTTP client per model.

The prototype puts `resolve()` in the transport — its own footer says the module is
"meant to lift into `qwen_ui_pipeline/providers/`"
(`prototype/model-capability-resolver`, commit `837e6f1`,
`qwen_ui_pipeline/providers/PROTOTYPE-capability-resolver.html:119-122`). **Judged
against the frozen seams, that placement is wrong for three independent reasons in
the current code.**

1. **The submission permit is consumed before the adapter is reached.**
   `invokeGeneration` calls `consumeSubmission` at
   `modules/generation/generation.ts:477-480` and only then invokes the adapter at
   `:481-484`. A resolver inside the adapter makes its downgrade decisions — a
   refusal included — *after* the Run is durably marked possibly-spent. #44 requires
   a capability mismatch to "fail before attempt reservation and spending," and #39
   names the refusal set as pre-reservation. Resolution must therefore run at
   planning.

2. **The prepared payload is a proof document that reconstruction pins exactly.**
   `prepareGeneration` builds a payload whose only keys are `input_references`,
   `model`, `provider`, `requested_count`
   (`modules/generation/generation.ts:391-396`), and
   `validatePreparedGeneration` rebuilds it from the immutable request and demands
   exact equality before submission (`:306-334`, refusal at `:327-332`). Any control
   a transport-time resolver added or withheld would sit *outside* that digest chain
   — the frozen freeze-before-submit guarantee (#47 user story 16) would not cover
   the fields most likely to be wrong.

3. **A transport that edits the reviewed request is the thing
   `PROVIDER_SUBSTITUTION` exists to deny.** `modules/generation/generation.ts:423-425`
   fails when an adapter returns a different provider or model. Withholding a control
   is the same class of act — the adapter silently altering what was reviewed.

**Correct placement.** The resolver is a pure function

`(Image Plan intent, Model Profile capability record) → (resolved control set, downgrade report)`

evaluated during `compilePlannedRun`
(`modules/run-contract/index.ts:18-27`), with both outputs frozen into the
immutable Run Request before `reserve`. The transport then becomes a pure serializer
of an already-resolved control set — which *strengthens* #44's "one generic
transport with injected, locked Model Profiles" rather than competing with it,
because the transport no longer needs to know anything model-specific at all.

The prototype's `CAPABILITIES` table
(`PROTOTYPE-capability-resolver.html:146-190`) is the right shape and lifts into the
Model Profile *data*; its `resolve()` (`:226-312`) lifts into planning. Two things
in the prototype must not lift as written: `sizeForRatio` (`:210-220`) predicts
dimensions the model does not honor, and the prototype itself says so
(`:206-208`) — the resolver may pin a ratio but must never record a predicted pixel
size as fact; and `maxReferences: null` (`:164`) collapses "unprobed" into "no
limit", which is precisely the third state #49 has to name.

## Seam map

Frozen units are the interface file, its error set, and its acceptance suite
(`MODULES.md`). Every row below is a change to at least one of those three.

| Frozen unit | Symbol the resolver touches | What it needs | Disposition |
| --- | --- | --- | --- |
| Run Contract interface — `modules/run-contract/types.ts` | `CanonicalRunRequest` (`:62-98`); `mode: "qwen-image" \| "seedance-video"` (`:68`); `AssemblyPlan` (`:32-47`); `VideoPlan` (`:49-60`) | A model-neutral image mode, an Image Plan carrying declared *intent*, a resolved control set, a capability-record identity, and a `downgradeReportSha256`. The request carries no image control of any kind today — no framing, no seed, no output format. | **Seam change.** Already opened by #47/#56 (schema v2 + Image Plan). The resolved-control-set and downgrade-report fields are new to it. |
| Run Contract errors — `modules/run-contract/errors.ts:1-12` | 11 codes; none capability-related | `UnsupportedImageControl`, `ModelProfileDrift`, `ModelProfileUnavailable`, `ProviderRouteUnavailable` (all four named by #39), **plus** measured-only codes #39 does not have: capability record absent, stale, unprobed, contradicted. | **Seam change.** First four in #47's scope; the measured-only four are not. |
| Run Contract acceptance — `modules/run-contract/run-contract.test.ts`; decoder `run-contract.ts:423-427` | Mode allowlist refuses anything but the two v1 modes | Resolution cases, per-field disposition matrix, refusal-vs-withhold cases | **Seam change.** |
| Conductor errors — `modules/conductor/errors.ts` | `PlanningRefusalCode` (`:1-23`) mirrors Run Contract's codes; `ConductorErrorCode` (`:30-39`) leads with `ADVANCE_REQUIRES_QWEN_ASSEMBLY` (`:31`), raised at `conductor.ts:783-788` | The same new refusal codes surfaced at the planning front door | **Seam change.** Mirror of the row above. |
| Conductor interface — `modules/conductor/types.ts` | `NormalView` (`:8-14`); `PlanDecision` (`:35-47`) | The Normal View is the only plain-language surface planning returns. A downgrade must appear there or the caller never learns what was withheld. | **Seam change.** #45 lists the caller-surface shape as not yet specified; #50 owns it. |
| Generation interface — `modules/generation/types.ts` | `PreparedGeneration.payload` (`:15-21`) and its construction (`generation.ts:391-396`); `GeneratedArtifact.mediaType` fixed to `"application/vnd.qwen.rgba+json"` (`:25`); `GenerationResult` (`:36-41`) has no cost and no measured dimensions | The resolved control set must enter the payload proof so reconstruction (`generation.ts:306-334`) covers it; the result must carry measured output dimensions for the ratio contract | **Seam change.** Media type and cost already in #38/#47 scope; resolved controls in the proof document are new. |
| Generation errors — `modules/generation/errors.ts:1-8` | 7 codes; `PROVIDER_SUBSTITUTION` (`:6`), `OUTPUT_COUNT_MISMATCH` (`:7`) | A post-hoc code for "the response contradicts a measured capability claim" (e.g. returned dimensions off the pinned ratio) | **Seam change**, small. |
| Run Record interface — `modules/run-record/types.ts` | `RecordOperation` union (`:133-204`) has no capability event; `RunRecordView` (`:219-254`) has `costState`/`actualCostUsd`/`completedCount` but no downgrade, no observed dimensions, no reproducibility state | A durable capability-resolution event written **before** reservation, and view fields to replay it | **Seam change.** Not in #47's scope at all. |
| Run Record errors — `modules/run-record/errors.ts:1-25` | 25 codes | Likely none new; resolution failures are pre-reservation and belong to Run Contract | **Additive/none.** |
| Provider Evidence Sanitizer — `provider-evidence-sanitizer.ts:215-218` | `SanitizedProviderDocumentKind = "qwen" \| "seedance-submission" \| "seedance-poll"`; enforced at `run-record.ts:1193, 2127` and `generation.ts:434` | A generic OpenRouter image receipt kind whose closed schema admits measured dimensions and `usage.cost` | **Seam change.** Already in #38/#47 scope. |
| Verification — `modules/verification/types.ts:15-19`, `errors.ts:1-5` | Check names are `integrity \| media \| outside-region-preservation \| donor-equality-inside-region` | A ratio check for a ratio-contract model reads on the *response*, not the plan | **Seam change**, owned by #51, not this note. |
| Neutral Procedure fixture — `tests/control-plane-fixture.ts:285-325` | Procedures declare `mode`, `provider`, `model`, `maximumCount`, `unitCostUsd`, `referenceRequirements` — **no capability fields at all** | A capability record with authority kind and per-field disposition | **Seam change.** This fixture is where a no-cost, no-network conformance suite for a second profile has to start (#45, "Not yet specified"). |
| CONTEXT vocabulary — `CONTEXT.md:23-24` | "**Render Pass**: One image-model invocation with a fixed Edit Brief, inputs, **and seed**." | A Muse Render Pass has no seed. The canonical definition is model-specific and false for a measured-only model. | **Supersede.** #44 already requires CONTEXT edits on the v0.4 line; this one is not on its list. |
| Legacy Python direct path — `providers/openrouter.py:140-165`, `providers/router.py:19-50`, `partner_controls.py:12-19, 82-92` | `build_openrouter_request` (the map's named anti-goal); `provider: auto` and the Alibaba fallback (`router.py:28, 41-49`); count 1–6 and a mandatory numeric seed | Nothing. These are the bypasses #30 removes. | **Not a resolver host.** Adding a Muse branch here is #45's explicit anti-goal. |

ADR 0001 ([`docs/adr/0001-separate-rendering-from-assembly.md`](../adr/0001-separate-rendering-from-assembly.md))
**stands and is strengthened**, not superseded: #45's evidence item 7 (Muse put
Washington DC in Kansas; deterministic placement fixed it completely at no
per-iteration cost) is the same decision confirmed on a second model. #55 owns
promoting it to a repo-level rule.

## #44 clauses: supersede, sharpen, stand

**Must be sharpened (not reversed):**

1. "Unsupported fields are rejected explicitly. They are never silently omitted,
   forwarded speculatively, or replaced with a provider default." → Keep every word
   of the prohibition. Re-site the *refusal* from the field to the intent: refuse
   when no field on this model can satisfy a declared intent; withhold-and-report
   when the intent is satisfiable through a different field. Add: a withheld field
   must appear in a downgrade report hashed into the immutable Run Request, which is
   what distinguishes withholding from silent omission.
2. "…refreshes the relevant official OpenRouter model and endpoint records,
   canonicalizes them, and compares their identity and supported/absent controls
   with the profile." → Add an authority kind per capability claim. Comparison-drift
   is defined only for `declared` claims. An empty or absent endpoint record is a
   recorded *fact* about authority, never a passed comparison.
3. "…supported and absent controls…" (Model Profile definition) → The binary
   supported/absent is insufficient. Four dispositions are measured on Muse:
   honored, coerced, ignored, and (for Qwen's `size`) unsupported-and-rejected.

**Must be superseded:**

4. "Provider routing is explicit and fallback is disabled." → The *fallback*
   half stands unconditionally. The *explicit route* half assumes a reviewable
   endpoint list; Muse's is empty, so no route can be named or reviewed in advance.
   Inference: `allow_fallback: false` can still be sent, but "explicit provider
   route" as an item of *reviewed evidence* is unavailable for Muse and must be
   representable as `route: unknown` rather than faked. This is a genuine
   contradiction and belongs to #49.

**Stand unchanged, and are strengthened by the resolver:**

5. "Use one generic OpenRouter image transport with injected, locked Model
   Profiles, not one HTTP client per model." — a planning-time resolver is what
   makes a truly model-agnostic transport possible.
6. "The immutable Run Request locks the exact Model Profile bytes and digest."
   — empty-endpoints bytes are still bytes.
7. "Drift never patches an existing Run. Maintainers review and version the Model
   Profile, then the application creates a new linked Run." — unchanged; a re-measured
   capability record is a new profile version by exactly this rule.
8. "…returned media and **measured dimensions**…" (Receipt definition) — already
   correct, and becomes load-bearing for the ratio contract.
9. "Actual OpenRouter `usage.cost` is recorded when present; absence is `unknown`,
   never zero."
10. The Assembly and Verification section in full.

## #47: the resolver does not fit inside its scope as written

#47 is a specification for *declared* capability. Its Model Profile is "the
authority for display name, stable profile ID, exact model family and canonical
identity, provider route, fallback policy, privacy expectations, capability set, and
cost metadata" — no measurement provenance, no per-field disposition, no unprobed
state. These named clauses must be superseded for a resolver to land inside it:

- Implementation Decisions, the Model Profile authority sentence quoted above →
  add capability authority kind and measurement provenance (date, method, benchmark
  link, observed values, the request that produced them).
- Implementation Decisions: "The generic OpenRouter image adapter prepares from
  Image Plan plus Model Profile, validates before client creation, submits once…"
  → this places resolution in the adapter. Supersede: resolution happens in
  planning; the adapter serializes an already-resolved control set.
- Implementation Decisions: "Preview identities, route changes, retention changes,
  or material capability drift are named pre-submission refusals." → drift is
  undefined for a measured-only model; see #44 clause 2 above.
- User story 9: "I want model capabilities declared in the profile, so that
  unsupported controls **fail** before any paid submission." → intent-level refusal,
  field-level withholding.
- Acceptance criterion: "Unsupported controls, identity/route/privacy/capability
  drift, and fallback are named local refusals before paid submission." → same
  sharpening.
- Testing Decisions: "Profile tests prove canonical hashing, exact identity/route,
  fallback=false, privacy/capability expectations, control matrices, and named drift
  refusals." → add measured-claim staleness and an honored/coerced/ignored/unprobed
  matrix.

User story 11 ("size and aspect-ratio validation to be model-specific") survives
unchanged — it is exactly what the resolver does. #56 is the ticket whose acceptance
criteria would carry the resolver ("Public interfaces, named error outcomes, and
acceptance tests are established before implementation and remain stable within this
Issue"), so the supersessions above have to land before #56 starts.

## What a downgrade report requires

Per control the Image Plan expressed an intent for:

- `control` — canonical intent name (`framing`, `reproducibility`, `outputCount`,
  `references`, `outputFormat`), not a wire field name
- `intent` — what the caller asked for, verbatim from the Image Plan
- `authority` — `declared` \| `measured` \| `unprobed`
- `disposition` — `honored` \| `coerced` \| `withheld` \| `refused`
- `sentAs` — the exact wire field(s) and value(s) sent, or `null`
- `withheldField` — the wire field deliberately **not** sent; this field is what
  makes the omission non-silent under #44
- `effect` — the measured consequence in plain words ("this model collapses
  `aspect_ratio` to three buckets; 16:9 would return 1920x1280")
- `evidenceRef` — capability-record entry id plus its measurement date, method, and
  source URL

Run-level:

- `reproducible: boolean`, and when false, the reason. Note the interface pressure
  #53 inherits: `CanonicalRunRequest` has **no seed field at all**
  (`modules/run-contract/types.ts:62-98`), so a decorative seed has nowhere honest to
  live except this report.
- `pixelAuthority` — `exact-pixels` \| `ratio-only`; with `expectedRatio` and
  `dimensionsAuthority: "response"` when ratio-only (#51 owns the check itself)
- `downgradeReportSha256` — hashed into the immutable Run Request

Run Record (`modules/run-record/types.ts`):

- a new `RecordOperation` variant committing the capability resolution, written
  **before** `reserve`, so the report is durable before any possibility of spend
- `RunRecordView` additions: `capabilityAuthority`, `downgradeReportSha256`,
  `withheldControls`, `reproducible`, `observedDimensions`

Receipt (#44's OpenRouter Image Receipt): `observedWidth`/`observedHeight` — already
covered by "measured dimensions" — plus a post-hoc confirmation that the response
does not contradict a measured claim.

Errors: `UnsupportedImageControl` (#39) for a refused intent; new named codes for
capability-record absent, stale, unprobed, and contradicted.

Normal View (`modules/conductor/types.ts:8-14`): one plain sentence per withheld
control. #45 records the per-surface shape (CLI, generic ComfyUI node, Normal View)
as not yet specified; #50 owns it.

## What this note does not decide

Authority precedence between a measured and a declared claim, refresh triggers, and
the treatment of an unprobed field are #49's. What to do with an ignored field at
each caller surface is #50's. The ratio contract and its response-side check are
#51's. Content-class refusal is #52's. The decorative-seed representation is #53's.
Timeouts and the possibly-billed rule are #54's. This note reports interface
pressure only; it changes no interface, error set, acceptance suite, or ADR.

## Verification scope

Read-only apart from this file on `research/48-capability-resolver-seam`. Repository
verification for the note is limited to Markdown and `git diff --check`; the
canonical baseline (`scripts/verify.sh`) cannot contact OpenRouter, load a model, or
perform generation, and none was attempted.
