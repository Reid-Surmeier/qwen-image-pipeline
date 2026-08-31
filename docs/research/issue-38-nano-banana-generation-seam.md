# Issue 38: Nano Banana 2 at the frozen Generation seam

Issue: [Research: map Nano Banana 2 onto the frozen Generation seam](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/38)

Checked 2026-08-31 against exact build commit
[`6f475bedbf51cd3e2a42c21574c4c61234a3a145`](https://github.com/Reid-Surmeier/qwen-image-pipeline/tree/6f475bedbf51cd3e2a42c21574c4c61234a3a145),
the live head of `origin/build/v0.3.0` when this research began. No credential was
read, no provider submission was attempted, and no paid work occurred.

## Answer

**The OpenRouter transport portion can be an additive adapter/profile, but the
requested trustworthy, selectable Nano Banana 2 capability cannot be added
honestly without a new versioned image contract.** Reusing the existing
`qwen-image` mode would make the code run under a false canonical identity and
would omit model-specific capability, request-parameter, response-cost, and
durable-evidence facts. That would contradict the accepted Run Request and Run
Record decision rather than preserve it.

The safe release implication is therefore: finish and release v0.3.0 as scoped,
then make Nano Banana 2 part of the next build line (expected v0.4.0) through
separate Issues that explicitly revise the frozen Run Contract, Generation,
Run Record, Conductor, and acceptance seams. The high-level Conductor procedure
can remain `plan` then `advance`; its image branch and named errors cannot remain
byte-for-byte unchanged.

## Current external contract

OpenRouter's current stable request slug is
`google/gemini-3.1-flash-image`; its permanent dated slug is
`google/gemini-3.1-flash-image-20260528`. OpenRouter exposes it through the
same synchronous `POST /api/v1/images` route used by the inherited Qwen client.
The current endpoint record advertises text and optional image references in,
image out, `n` fixed at one, zero through fourteen references, 512/1K/2K/4K
resolution tiers, a bounded aspect-ratio allowlist, and no `seed` capability.
It currently lists Google Vertex and Google AI Studio endpoints and only
`cachedContent` as a provider-specific passthrough field. These are live facts,
not timeless constants; an absent capability is unsupported and the exact
endpoint snapshot must be locked before paid submission.

The request body uses `model`, `prompt`, `n`, `resolution`, `aspect_ratio`,
optional `input_references`, and an explicit `provider` routing object.
References are ordered `image_url` records whose URL may be HTTP(S) or a base64
data URL. A buffered response contains base64 image bytes plus media type and a
usage record that may expose actual cost. Primary sources:

- [OpenRouter image-generation contract](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [OpenRouter Nano Banana 2 endpoint record](https://openrouter.ai/api/v1/images/models/google/gemini-3.1-flash-image/endpoints)
- [OpenRouter image-model discovery](https://openrouter.ai/api/v1/images/models)
- [Google Nano Banana image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation)

The endpoint is compatible with the repository's standing OpenRouter-only
credential rule. The logical credential remains `OPENROUTER_API_KEY`; no Google
or direct-provider secret should be added.

## Accepted decisions that constrain the answer

- [The canonical Run Request and Run Record decision](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/4)
  requires an immutable provider/model, mode-specific parameters, exact
  reference-to-payload proof, requested/completed counts, cost evidence, and
  append-only authority before and after a paid effect.
- [The frozen module and TDD seam decision](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/5)
  makes Generation a model-adapter seam, Conductor the only normal front door,
  Run Record the only production writer, and each module interface, named error
  set, and acceptance tests a frozen unit. Changing any member needs a new
  Issue.
- [The v0.3.0 specification](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/17)
  names Qwen Image and Seedance, requires existing CLI and ComfyUI entry points
  to become Conductor delegates, and explicitly leaves a new model provider out
  of scope. Its current review surface is
  [Build v0.3.0](https://github.com/Reid-Surmeier/qwen-image-pipeline/pull/33).
- [ADR 0003](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/docs/adr/0003-bound-paid-verification-to-openrouter.md)
  already permits only explicit OpenRouter paid work and forbids blind retry.
  Nano Banana 2 needs no new credential route.

## Seam map

| Surface | What already fits additively | What does not fit the frozen contract | Required disposition |
| --- | --- | --- | --- |
| Generation adapter | `GenerationAdapterService.invoke` and optional `recover` receive a prepared request and return provider/model identity, sanitized evidence, and normalized outputs. Provider is already the literal `openrouter` and model is an arbitrary string ([types](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/generation/types.ts#L30-L101)). A new concrete OpenRouter image adapter can translate ordered locked references to data URLs, call the existing Image endpoint once, decode returned bytes, and normalize them to canonical RGBA evidence. | `GeneratedArtifact` is literally `application/vnd.qwen.rgba+json`; provider receipts are validated as kind `qwen`; messages and recovery names are Qwen-specific. `GenerationResult` carries no image cost evidence. The adapter service has no injected capability snapshot despite the accepted dependency. | Add the transport/normalizer/profile implementation only after an Issue versions or generalizes these frozen types, evidence kinds, errors, and tests. Preserve the one-use permit and exact-model substitution checks. |
| Prepared payload | Preparation already binds canonical request and payload hashes and proves every locked image reaches its exact ordered payload location ([preparation](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/generation/generation.ts#L253-L409)). Nano's ordered `input_references` map naturally to this proof. | The prepared document has only `input_references`, model, provider, and requested count. It has no prompt field distinct from the objective summary, resolution, aspect ratio, output format, provider endpoint pin, capability-snapshot identity, or explicit unsupported-seed state. It is an internal proof document, not a complete Nano wire request. | Add a versioned image plan/profile to the canonical request and derive the exact provider wire payload from it. Do not let the adapter invent omitted values. |
| Capability snapshot | A model profile can be a new immutable data file populated from OpenRouter's public discovery and endpoint records. Nano and Qwen can share one generic OpenRouter image-profile loader and validator. | No control-plane capability snapshot exists today. The test Project Contract hard-codes model, maximum count, and unit cost only ([fixture](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/tests/control-plane-fixture.ts#L285-L325)). The inherited Qwen path hard-codes a four-reference maximum, sizes, counts, and seed assumptions. | A new Issue must decide snapshot ownership, schema, digest/source/as-of fields, refresh policy, and which identity is copied into the immutable Run Request. Runtime must fail closed when the planned capability is absent or changed. |
| Run Contract and schema | Provider `openrouter`, free model string, Procedure selection by `procedureId`, count, budget ceiling, and exact reference destinations are reusable ([request type](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/run-contract/types.ts#L41-L92)). Easy switching should happen by selecting a different locked Procedure/profile before planning, never by mutating an existing Run. | The only modes are `qwen-image` and `seedance-video`; Assembly plans are explicitly Qwen-only; image-specific parameters and capability identity are missing; a Nano endpoint does not advertise seed. The decoder rejects any other mode ([decoder](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/run-contract/run-contract.ts#L415-L530)). | Introduce a new schema/Procedure version with a model-neutral image mode and image plan while retaining a reader for recorded v1 `qwen-image` Runs. Update interface, errors, MODULE, and acceptance fixtures under a dedicated Issue. Tool Locks must pin the new Run schema, adapter protocol, Procedure, artifact, commit, and capability/profile identity. |
| Conductor | The accepted phase order—read locked references, prepare, reserve, mark possibly spent, invoke once, persist evidence/outputs, choose donor, assemble, verify—works unchanged conceptually for Nano. `plan(objectivePath)` and `advance(run)` need not gain a new public operation. | The image branch refuses anything except `qwen-image` with required Assembly and raises `ADVANCE_REQUIRES_QWEN_ASSEMBLY`; persisted evidence, recovery, and Normal View text repeatedly name Qwen ([image branch](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/conductor/conductor.ts#L775-L940), [errors](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/conductor/errors.ts#L30-L50)). | Keep the public plan/advance procedure and its safety order, but generalize the internal image dispatch, names, and acceptance cases in a new frozen-seam Issue. Do not route Nano through the Seedance submit/poll path. |
| Run Record and provider receipts | Immutable request bytes, one-use submission authority, append-only events, write-once evidence, output hashes, Assembly, checks, replay, and ambiguity policy are reusable without weakening. | Non-video provider evidence is unconditionally classified as Qwen, generated outputs must be Qwen `.rgba.json`, and actual-cost state exists only on Seedance completion ([receipt replay](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/run-record/run-record.ts#L1160-L1200), [write validation](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/run-record/run-record.ts#L2121-L2143), [view](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/run-record/types.ts#L219-L253)). OpenRouter's Nano response exposes actual cost and image bytes, neither of which can be represented faithfully in the current image result. | Version the generic image receipt and output/cost events, preserve v1 replay, and add Nano and known-bad fixtures. This changes Run Record interface/tests and requires its own Issue. |
| Provider Evidence Sanitizer | The credential, duplicate-key, closed-wrapper, and defensive-copy machinery is reusable. | Its public kind union is exactly `qwen`, `seedance-submission`, or `seedance-poll`, and the image receipt schemas are named and shaped for Qwen ([kind and schema](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/provider-evidence-sanitizer/provider-evidence-sanitizer.ts#L215-L285), [dispatch](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/modules/provider-evidence-sanitizer/provider-evidence-sanitizer.ts#L356-L371)). | Add a versioned generic OpenRouter-image receipt or explicit Nano receipt with closed fields for response identity, counts, usage/cost, and sanitized output receipts. Changing its kind union and acceptance file is a frozen-seam Issue. |
| Reference Planning | Ordered image references and exact JSON-pointer destinations already work for Nano's `input_references`; no provider access is needed during planning. | The mode type is coupled to `qwen-image`; model-specific zero-reference generation has no existing neutral fixture, while the current image fixture always requires one authoritative source for Assembly. | Reuse the logic, but add model-neutral image and zero-reference cases only with the versioned Run Contract decision. Reference hashing and authority rules must not loosen. |
| Assembly and Verification | Nano output can be normalized into the same RGBA donor representation and then follow identical deterministic Assembly and fidelity checks. Model identity should not change pixel-ownership rules. | The Run Contract and Conductor call this specifically the Qwen Assembly path, and existing acceptance fixtures bind those names. Text-only generation without authoritative pixels needs an explicit image-plan decision about whether Assembly is required; it cannot silently bypass the existing guard. | Keep the modules' algorithms. Update only the upstream plan semantics and cross-module fixture names unless a later decision discovers a genuinely new Assembly or Verification need. |

## Legacy Qwen/OpenRouter assumptions to isolate

The inherited Python implementation is useful adapter code, not the successor
control plane. Its generic HTTP client and buffered response decoder can be
reused, but these Qwen-specific assumptions cannot become Nano defaults:

- `qwen_ui_pipeline/providers/openrouter.py` defaults to
  `qwen/qwen-image-3-pro`, caps references at four, always sends `n`, and sends
  `seed` whenever present
  ([source](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/qwen_ui_pipeline/providers/openrouter.py#L20-L22),
  [request builder](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/qwen_ui_pipeline/providers/openrouter.py#L140-L165)).
- `qwen_ui_pipeline/partner_controls.py` admits only Qwen model aliases, one to
  six outputs, a mandatory numeric seed, Qwen-derived dimensions, and at most
  three visible references
  ([controls](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/qwen_ui_pipeline/partner_controls.py#L12-L32),
  [validation](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/qwen_ui_pipeline/partner_controls.py#L63-L105)).
- `qwen_ui_pipeline/providers/router.py` still supports `provider: auto` and a
  direct Alibaba fallback. That is prohibited in the successor normal path and
  must not be copied into a Nano adapter
  ([router](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/qwen_ui_pipeline/providers/router.py#L19-L50)).
- The OpenRouter timeout environment name and user agent are Qwen-branded. A
  shared OpenRouter image transport needs neutral names while preserving legacy
  compatibility and the existing ambiguous-timeout treatment.

The smallest adapter-local implementation after the contract decision is one
OpenRouter image transport plus model profiles, not a second HTTP client:

1. retain `POST /api/v1/images`, `OPENROUTER_API_KEY`, keepalive, timeout, error
   capture, and base64 decoding;
2. select a frozen profile by exact model slug and provider endpoint policy;
3. derive only parameters the profile advertises, refusing Nano count above one
   and any seed before consuming the submission permit;
4. translate the locked reference records into ordered base64 data URLs and
   prove the final wire request against the prepared digest;
5. normalize image bytes to canonical RGBA donors and normalize the response to
   the new closed image receipt including actual cost when exposed.

## CLI and ComfyUI exposure

The current Python CLI `generate` command and `QwenImage3*` ComfyUI nodes submit
directly through the inherited provider router, outside Conductor
([CLI](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/qwen_ui_pipeline/cli.py#L49-L61),
[direct execution](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/qwen_ui_pipeline/cli.py#L199-L227),
[ComfyUI nodes](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/qwen_ui_pipeline/comfyui_node.py#L168-L281)).
Adding Nano to their model tuple would make another unsafe direct submission
path and would mislabel it as Qwen. Do not do that.

The v0.4 exposure should follow the still-pending v0.3 caller migration:

- the application Project Contract contains separate Qwen and Nano Procedures,
  each binding exact model/profile/capability identity and conservative budget;
- an Objective selects one `procedureId` before `Conductor.plan`; switching
  models creates a distinct Planned Run and never mutates or falls back within
  an existing Run;
- the normal CLI exposes plan/advance and Procedure selection, then delegates to
  Conductor;
- existing `QwenImage3Render`, `QwenImage3TextToImage`, and `QwenImage3Edit`
  class IDs and saved workflows remain readable under their accepted
  compatibility contract;
- a new model-neutral OpenRouter image node may expose the same Procedure choice
  for new workflows, but its queue action must invoke Conductor rather than the
  legacy router. A Nano-specific direct node is not an acceptable shortcut.

[ADR 0004](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/6f475bedbf51cd3e2a42c21574c4c61234a3a145/docs/adr/0004-add-partner-compatible-controls-beside-edit-brief-json.md)
freezes the existing Qwen node IDs and compatibility behavior. A generic node
and saved-workflow migration policy therefore need an explicit ADR amendment or
successor ADR, even when old class IDs remain registered.

## Compatibility and migration risks

1. **False identity:** treating Nano as `qwen-image` makes immutable requests,
   findings, logs, and replay semantically wrong even if the API request works.
2. **Silent unsupported controls:** Nano currently accepts one output and does
   not advertise seed; inherited Qwen controls accept up to six and always
   surface seed. Passing or discarding either silently is a pre-submit defect.
3. **Capability drift:** stable slugs can retain their name while endpoint
   capabilities, provider availability, and prices change. A URL alone is not
   a snapshot; record canonical bytes/hash/as-of/provider route in planning.
4. **Historical replay:** changing the meaning of `qwen-image`, `qwen` receipt,
   or `application/vnd.qwen.rgba+json` in place would make old Runs unreadable.
   Keep v1 decoders and introduce a new schema/procedure/adapter version.
5. **Saved ComfyUI workflows:** renaming or repurposing Qwen class IDs breaks the
   accepted compatibility promise. Add new generic IDs and tested delegation.
6. **Actual cost loss:** the current image path persists no actual-cost state.
   Omitting OpenRouter usage cost would violate the accepted provenance record.
7. **Fallback duplication:** OpenRouter can route among upstream endpoints.
   The Nano profile must set an explicit provider policy and disable fallback
   when required by the governing decision; the inherited `provider: auto`
   behavior must stay outside the normal path.
8. **Text-only generation semantics:** zero-reference generation is supported by
   Nano, but the current trustworthy image path assumes an authoritative image
   and mandatory donor Assembly. A new image plan must state when no
   authoritative pixels exist and what verification replaces preservation
   checks; this is a product/procedure decision, not adapter inference.

## Issue and ADR triggers

The following are separate implementation decisions because they touch frozen
interfaces, errors, tests, schema authority, or long-term data flow:

1. Version the model-neutral image Run Request/Image Plan, capability snapshot,
   old-Run reader, and Tool Lock implications (Run Contract + Reference
   Planning Issue; ADR for the new source of truth and schema version).
2. Generalize Generation results, capability enforcement, provider receipts,
   image actual-cost evidence, and add the concrete OpenRouter image adapter
   with Qwen and Nano profiles (Generation + Provider Evidence Sanitizer Issue).
3. Generalize Conductor's image branch and Run Record replay while preserving
   the exact plan/advance procedure, one-use permit, Assembly rule, and v1 replay
   (Conductor + Run Record Issue; ADR only if procedure ordering or ownership
   changes).
4. Expose Procedure selection through the Conductor-delegating CLI and a new
   generic ComfyUI node while retaining Qwen class IDs and saved workflows
   (compatibility Issue plus successor/amendment to ADR 0004).
5. Perform no-cost fake Nano generation and edit tests first, then a separately
   authorized live qualification using exactly one text-to-image and one
   reference-guided output, full provenance, and no retry after ambiguity.

The present Issue resolves only the seam map. It does not authorize any of
those interface changes or the live qualification.

## Verification scope

Research was read-only apart from this note. Repository verification for the
note is limited to Markdown/diff checks and the deterministic baseline; neither
can contact OpenRouter, load a model, or perform generation.
