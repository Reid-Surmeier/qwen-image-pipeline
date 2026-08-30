# Issue 2: inherited generation, Seedance, Assembly, validation, and evidence flows

Issue: [Research: map the inherited generation, Seedance, Assembly, validation, and evidence flows](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/2)

Baseline: `b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b`

## Answer

The inherited repository has substantial reusable depth, but it does **not**
currently implement one enforced run procedure. It has separate working kernels
for Qwen request construction and provider routing, ComfyUI nodes, deterministic
region Assembly, pixel fidelity, independent region review, paid-attempt
sentinels, run-manifest validation, and a self-contained Seedance plan/submit/
poll/verify flow. Most of those kernels can be bypassed because the public
generation entry points do not compose them into a single lifecycle.

The most important gap is therefore orchestration, not another provider client.
The general Qwen CLI writes evidence only after a provider response; its
versioned run-manifest validator is a separate command; deterministic Assembly
is a separate workflow generator; fidelity and independent review are callable
libraries with no production caller; and crash-safe no-retry evidence is used by
selected Issue scripts rather than by the general runner. Seedance is deeper as
an end-to-end procedure, including a real-reference gate and request-hash/cost
lock, but it uses a separate run layout and is excluded from the root baseline.

This supports a cleanup that preserves the kernels while making the procedure
explicit and executable. It does not support rewriting the repository from
scratch.

## Method and confidence

This inventory uses only repository-owned primary evidence: source, schemas,
tests, ADRs, and tracked artifacts at the pinned baseline. GitNexus was bound to
the exact `qwen-release-v0.2.0` index at the same commit (728 files, 4,714
symbols, 257 inferred processes, no incomplete-index reasons). Its Qwen Render
trace corroborated `ComfyUI render -> provider router -> provider adapter -> Edit
Brief compiler`; its Seedance trace corroborated `plan -> strategy gate ->
reference registry`. Source was then read directly for every conclusion below.

The tracked-file inventory at this baseline is reproducible with
`git ls-files <directory> | wc -l`: `qwen_ui_pipeline/` has 18 files, `tests/`
24, `scripts/` 17, `schemas/` 3, while `artifacts/` has 523, `godot/` 340, and
`seedance/` 505. Counts classify accumulation; they do not decide what to delete.

## Public entry points

| Surface | Public interface | What it actually owns |
| --- | --- | --- |
| Root CLIs | `qwen-ui-pipeline` / `python -m qwen_ui_pipeline`; `qwen-worker-capacity` | The package registers both executables in [`pyproject.toml`](../../pyproject.toml#L5-L16). The primary CLI owns `compile`, `generate`, `workflow`, `assembly-workflow`, `component-workflow`, and `record-comfy`; command registration is explicit in [`cli.py`](../../qwen_ui_pipeline/cli.py#L49-L98), while dispatch and provider execution live in [`cli.py`](../../qwen_ui_pipeline/cli.py#L101-L227). |
| Python package | `import qwen_ui_pipeline` | A broad façade re-exporting capacity, fidelity, independent verification, workflow construction, provider clients/router, prompt compilation, and artifact writing from [`__init__.py`](../../qwen_ui_pipeline/__init__.py#L1-L112). It is an export list, not an orchestrated module map. |
| ComfyUI custom nodes | `QwenImage3TextToImage`, `QwenImage3Edit`, `QwenImage3Render`, `ReferenceRegionComposite` | Four registered nodes in [`comfyui_node.py`](../../qwen_ui_pipeline/comfyui_node.py#L402-L413); the custom-node package is only a registration wrapper over those mappings ([`__init__.py`](../../comfyui_custom_nodes/qwen_image_3_openrouter/__init__.py#L1-L8)). |
| Run-manifest validator | `python -m qwen_ui_pipeline.run_manifest <manifest.json>` | A separate fail-closed validator whose CLI reads one JSON file and reports errors ([`run_manifest.py`](../../qwen_ui_pipeline/run_manifest.py#L219-L238)). It is not called by `generate`, `record-comfy`, or the ComfyUI nodes. |
| Seedance CLI | `seedance-icons` | A separately packaged CLI ([`pyproject.toml`](../../seedance/pyproject.toml#L17-L21)) with `capabilities`, `plan`, `submit`, `wait`, deterministic retro conformance, and `verify` ([`cli.py`](../../seedance/src/seedance_icons/cli.py#L249-L354)). |
| Seedance ComfyUI nodes | `SeedanceIconPrompt`, `SeedancePlanRequest` | Planning only: compile a prompt, validate a request against supplied capability metadata, and estimate cost. The nodes deliberately do not submit ([`nodes.py`](../../seedance/comfyui_custom_nodes/seedance_icon_animation/nodes.py#L1-L10), [`nodes.py`](../../seedance/comfyui_custom_nodes/seedance_icon_animation/nodes.py#L47-L99)). |

## Qwen Image generation flow

### Legacy Edit Brief path

1. `QwenImage3Render.render` parses a JSON object, converts at most four input
   images to embedded PNG data URLs, constructs whichever clients have keys,
   and calls the shared provider router ([`comfyui_node.py`](../../qwen_ui_pipeline/comfyui_node.py#L33-L50),
   [`comfyui_node.py`](../../qwen_ui_pipeline/comfyui_node.py#L284-L347)).
2. `generate_with_provider` validates only the provider name. In `auto` mode it
   tries OpenRouter, and falls back to Alibaba only when a `RuntimeError` string
   contains the privacy-guardrail phrase; explicit OpenRouter never falls back
   ([`router.py`](../../qwen_ui_pipeline/providers/router.py#L19-L50)).
3. Each adapter compiles the same Edit Brief, then translates it to a
   provider-specific body. OpenRouter emits `model`, compiled `prompt`,
   `resolution`, `aspect_ratio`, `n`, optional `seed`, and optional
   `input_references` ([`openrouter.py`](../../qwen_ui_pipeline/providers/openrouter.py#L140-L165)).
   Alibaba emits multimodal `messages` and a `parameters` object, resolves
   provider URLs immediately, and normalizes results to base64 image records
   ([`alibaba.py`](../../qwen_ui_pipeline/providers/alibaba.py#L99-L152),
   [`alibaba.py`](../../qwen_ui_pipeline/providers/alibaba.py#L155-L202)).
4. The node decodes image responses into tensors and returns lightweight run
   metadata. The legacy metadata contains provider, model, resolution, aspect,
   count, seed, and usage, but no reference hashes, output hashes, request
   identity, timestamps, or retry verdict ([`comfyui_node.py`](../../qwen_ui_pipeline/comfyui_node.py#L304-L347)).

The root `generate` command joins the same router later in the flow. It embeds
reference files, reads both possible credentials, invokes the router, then
writes a run directory **after** a response has returned ([`cli.py`](../../qwen_ui_pipeline/cli.py#L162-L226)).
There is no durable pre-network attempt record on this general path.

### Partner-compatible path

The Partner nodes add real depth worth preserving:

- Three reference sockets have ordered, named roles. Gaps and batches are
  rejected, and each input is normalized to PNG with dimensions and SHA-256
  before provider execution ([`comfyui_node.py`](../../qwen_ui_pipeline/comfyui_node.py#L53-L90)).
- Provider/control combinations are validated while building the Edit Brief,
  before client creation; tests verify unsupported OpenRouter controls fail
  before a key is loaded ([`test_comfyui_node.py`](../../tests/test_comfyui_node.py#L106-L121)).
- Returned metadata includes provider/model, controls, reference identities,
  requested/completed counts, output hashes, usage, and request ID when the
  response exposes one ([`comfyui_node.py`](../../qwen_ui_pipeline/comfyui_node.py#L132-L165)).
- Saved workflows make source roles visible and keep Preview/Save lanes explicit
  ([`comfyui_workflow.py`](../../qwen_ui_pipeline/comfyui_workflow.py#L115-L171)).

This path still returns metadata through a ComfyUI string output. It does not
write or validate a canonical Run Record, install a paid-attempt sentinel,
classify an error, or require Assembly and checks before completion.

## Provider and error flow

The provider adapters are deliberately small synchronous clients. They keep
credentials out of workflow inputs and surface sanitized provider messages.
The OpenRouter client validates its timeout, uses TCP keepalive, parses an HTTP
error message, and raises `RuntimeError`; a non-object response is also a
`RuntimeError` ([`openrouter.py`](../../qwen_ui_pipeline/providers/openrouter.py#L80-L137)).
Alibaba follows the same broad error shape and raises when no image URL is
present ([`alibaba.py`](../../qwen_ui_pipeline/providers/alibaba.py#L99-L152)).

This is working transport depth, but not yet an error contract:

- HTTP status, transport phase, provider code, raw provider payload, request
  identity, possibly-billed state, and safe-to-retry are not represented as a
  typed result.
- Router fallback depends on substring matching one exception message
  ([`router.py`](../../qwen_ui_pipeline/providers/router.py#L37-L44)).
- The shared timeout override prevents disabling the timeout and fixes a prior
  CLI/node discrepancy, but its own source records that a client timeout can
  occur after the provider billed the image ([`openrouter.py`](../../qwen_ui_pipeline/providers/openrouter.py#L56-L77)).
- The generic artifact writer cannot record a failure because it is called only
  with a provider response.

The narrow fallback behavior is tested: only `auto` plus the named pre-billing
privacy block falls back, while explicit OpenRouter propagates the error
([`test_provider_fallback.py`](../../tests/test_provider_fallback.py#L28-L60)).
The inherited public schema and router still allow `auto` and direct Alibaba
([`edit-brief.schema.json`](../../schemas/edit-brief.schema.json#L6-L13),
[`router.py`](../../qwen_ui_pipeline/providers/router.py#L28-L49)); therefore the
current OpenRouter-only paid-action rule is a caller/procedure rule, not an
invariant enforced by the general runner.

## Current evidence and Run Record shapes

There are three incompatible evidence contracts rather than one Run Record.

### Image-generation artifact writer

`write_run_artifacts` persists image files plus `brief.json`, sanitized
`request.json`, sanitized `response.json`, `run.json`, and `prompt.txt`. Its
`run.json` holds output file records, usage, and an open-ended provenance object
([`openrouter.py`](../../qwen_ui_pipeline/providers/openrouter.py#L232-L286)).
It correctly removes embedded images from metadata and hashes every persisted
output, which tests cover ([`test_openrouter_client.py`](../../tests/test_openrouter_client.py#L114-L128),
[`test_openrouter_client.py`](../../tests/test_openrouter_client.py#L146-L170)).

It does not write the desired `events.jsonl`, `provider-response.json`,
`checks.json`, `failure.json`, or standalone `provenance.json`; it also does not
record start/end time, elapsed time, router address, error class, raw provider
message, or safe-to-retry. The provider request ID is present only when a caller
chooses to put it into the free-form provenance mapping.

### Versioned image/Assembly manifest

`run-manifest-v1` is stricter and separates `render` from `assembly`. It requires
run identity, commit, timestamp, status, source/output hashes, approvals, and
provider/generation data for renders; Assembly instead requires region and
fidelity evidence ([`run-manifest-v1.schema.json`](../../schemas/run-manifest-v1.schema.json#L1-L35),
[`run-manifest-v1.schema.json`](../../schemas/run-manifest-v1.schema.json#L36-L100)).
The Python validator adds semantic checks for repo-relative paths, secrets,
counts, approved-output hash coupling, and a request ceiling
([`run_manifest.py`](../../qwen_ui_pipeline/run_manifest.py#L90-L190)). It forbids
provider/generation fields on Assembly and requires deterministic fidelity
evidence instead ([`run_manifest.py`](../../qwen_ui_pipeline/run_manifest.py#L191-L215)).

This validator has no production caller, and `write_run_artifacts` does not
produce its shape. Passing validator tests therefore prove the validator, not
that ordinary runs are recorded under it. The tests explicitly cover valid
render/Assembly records, count drift, spend ceiling, approval/hash coupling,
secret-like content, unsafe paths, and incomplete runs
([`test_run_manifest.py`](../../tests/test_run_manifest.py#L78-L182)).

### Crash-safe paid-attempt sentinel

`PaidAttemptLedger.begin` creates `attempt.json` exclusively before submission,
fsyncs it and its directories, records a UUID and request hash, and defaults
`retry_allowed` to false ([`paid_attempts.py`](../../qwen_ui_pipeline/paid_attempts.py#L65-L97)).
Atomic updates preserve the attempt identity ([`paid_attempts.py`](../../qwen_ui_pipeline/paid_attempts.py#L99-L115)).
Tests prove that the sentinel blocks resubmission even before a response and
remains no-retry after completion ([`test_paid_attempts.py`](../../tests/test_paid_attempts.py#L11-L45)).

The class is partly application-specific despite its generic name: its evidence
paths assume `comparison.json`, `legacy`, `partner`, and Issue 32 wording
([`paid_attempts.py`](../../qwen_ui_pipeline/paid_attempts.py#L18-L55)). In production
source it is used by the Issue 32 side-by-side experiment, not by the root CLI,
ComfyUI nodes, or Seedance.

## Deterministic Assembly and checks

The Assembly kernel is real and small:

1. `assembly-workflow` emits `LoadImage(reference) -> LoadImage(generated) ->
   ReferenceRegionComposite -> SaveImage` ([`comfyui_workflow.py`](../../qwen_ui_pipeline/comfyui_workflow.py#L39-L72)).
2. `ReferenceRegionComposite` parses one `x,y,width,height` rectangle, rejects
   invalid/out-of-canvas geometry, normalizes the reference to survive
   ComfyUI's byte conversion, nearest-resizes the donor to the reference canvas,
   and copies only the declared rectangle ([`comfyui_node.py`](../../qwen_ui_pipeline/comfyui_node.py#L350-L399)).
3. `verify_against_baseline` separately proves that every changed pixel outside
   all licensed regions is absent, while reporting in-region changes without
   claiming semantic correctness ([`fidelity.py`](../../qwen_ui_pipeline/fidelity.py#L264-L321)).
4. `compare_palettes` separately detects loss of bitmap character inside a
   licensed region ([`fidelity.py`](../../qwen_ui_pipeline/fidelity.py#L334-L378)).
5. `run_verification` refuses to spend if deterministic fidelity already failed,
   sends bounded region crop pairs to an injected reviewer intended to be from
   a different model family,
   fails closed on unreadable/localization-free responses, and routes findings
   to the stage that owns them ([`verifier.py`](../../qwen_ui_pipeline/verifier.py#L248-L329)).

The missing enforcement is visible in the graph itself: the generated Assembly
workflow ends at `SaveImage`; there is no Fidelity Check node or required check
artifact after it. The fidelity and independent-review modules have test
callers, but no root CLI or ComfyUI production caller. Thus “Generation is
probabilistic; Assembly is deterministic” is represented in code, but Assembly
and its checks remain optional decisions rather than a mandatory executable
stage.

The different-family reviewer rule is documented on the injectable
`VisionClient`, but the implementation does not receive the builder model or
compare families; it is another procedure rule that is not mechanically proven
([`verifier.py`](../../qwen_ui_pipeline/verifier.py#L110-L123)).

The tests accurately cover the kernels: workflow topology
([`test_comfyui_workflow.py`](../../tests/test_comfyui_workflow.py#L33-L47)),
node inputs ([`test_comfyui_node.py`](../../tests/test_comfyui_node.py#L211-L219)),
fail-closed fidelity contracts and pixel evidence in `tests/test_fidelity.py`,
and independent-review behavior in `tests/test_verifier.py`. They do not contain
an integration test that begins with a generation request and can finish only
after Assembly, manifest validation, and checks all succeed.

## Seedance flow

Seedance is explicitly self-contained: its README says there are no imports in
either direction between `qwen_ui_pipeline` and `seedance_icons`, and the root
baseline neither runs nor depends on it ([`README.md`](../../seedance/README.md#L6-L25)).
That isolation is a useful future repository seam.

Its lifecycle is more coherent than the image path:

1. `capabilities` fetches OpenRouter's live supported model records. Model
   selection maps `study` to 2.0 Mini and `final` to 2.5, refuses silent upgrade,
   and validates duration, size, frames, mixed inputs, audio, and seed against
   the selected profile ([`capabilities.py`](../../seedance/src/seedance_icons/capabilities.py#L73-L120),
   [`capabilities.py`](../../seedance/src/seedance_icons/capabilities.py#L123-L155)).
2. `_plan` compiles the Motion Brief, creates exact frame/reference payload
   entries, validates the payload, and estimates cost from the selected live
   profile ([`cli.py`](../../seedance/src/seedance_icons/cli.py#L38-L69)).
3. `cmd_plan` executes a fail-closed strategy gate before creating an additive
   run, then writes the brief, sanitized request, ignored execution payload,
   capability snapshot, request digest, exact estimate, and gate record
   ([`cli.py`](../../seedance/src/seedance_icons/cli.py#L72-L118)).
4. The strategy gate requires a real resolving reference, an actual HTTPS video
   reference in the provider payload, matching declared/submitted registered
   reference identity, and compatible motion kind ([`strategy.py`](../../seedance/src/seedance_icons/strategy.py#L171-L254)).
   It also requires prompt depth and local anchors, with a pixel-crisp test for
   retro grammar ([`strategy.py`](../../seedance/src/seedance_icons/strategy.py#L257-L329)).
5. `cmd_submit` recomputes the payload hash, requires a passing or loudly waived
   strategy record, requires an exact decimal cost acknowledgement, refreshes
   live capabilities, rejects canonical model drift, validates again, submits
   once, and stores the job identity ([`cli.py`](../../seedance/src/seedance_icons/cli.py#L121-L161)).
6. `wait` resumes from `job.json`, polls the same job, downloads the output, and
   records terminal response plus output SHA-256 ([`cli.py`](../../seedance/src/seedance_icons/cli.py#L164-L175)).
7. `verify` checks media streams, duration, dimensions, audio, optional anchor
   RMSE, and loop seam, while explicitly requiring human style review
   ([`verify.py`](../../seedance/src/seedance_icons/verify.py#L58-L107)).

The exact defect described in Issue 2 is now covered: a video named only in
prose cannot pass planning. The provider payload must contain a video reference,
and submission refuses a payload changed after planning. Tests exercise both
facts ([`test_strategy.py`](../../seedance/tests/test_strategy.py#L119-L174),
[`test_submit_gate.py`](../../seedance/tests/test_submit_gate.py#L14-L41)).

Seedance still has evidence/retry gaps:

- Its run layout is a directory convention rather than the root versioned
  manifest; the contract lists `brief.json`, request files, capabilities,
  `plan.json`, job responses, output hash, and verification report
  ([`run-contract.md`](../../seedance/docs/run-contract.md#L1-L26)).
- Run creation is additive, but `write_json` is a plain write and submission has
  no exclusive pre-network sentinel comparable to `PaidAttemptLedger`
  ([`runs.py`](../../seedance/src/seedance_icons/runs.py#L9-L24),
  [`cli.py`](../../seedance/src/seedance_icons/cli.py#L153-L160)). Submission also
  does not refuse an already-marked plan or existing `job.json`. A process loss
  after POST but before `job.json` leaves ambiguous billing without a durable
  submission identity, and a repeated command can submit again.
- Poll failures and timeouts raise exceptions; there is no canonical
  `failure.json`, event stream, or safe-to-retry classification
  ([`openrouter.py`](../../seedance/src/seedance_icons/openrouter.py#L68-L96)).
- The motion brief JSON Schema is permissive (`additionalProperties: true`) and
  does not declare the later strategy fields; enforcement lives in Python
  ([`motion-brief.schema.json`](../../seedance/schemas/motion-brief.schema.json#L1-L17)).
- Root verification runs only root unittest/Node/compile checks and excludes the
  Seedance pytest/Ruff/validation suite ([`verify.sh`](../../scripts/verify.sh#L31-L34));
  the addon documents its own separate baseline ([`AGENTS.md`](../../seedance/AGENTS.md#L36-L45)).

## Duplication and application-specific accumulation

### Repeated orchestration

The repository repeatedly rebuilds the missing run lifecycle in experiment
scripts. `issue18_prompt_length.py`, `issue53_seed_variance.py`,
`issue54_reference_count.py`, and `issue70_t33_mitigation.py` each define their
own submit/collect flow and independently stop on ambiguous timeout.
`issue52_canvas_match.py`, `issue72_aspect_text.py`, and
`run_issue32_partner_side_by_side.py` each implement another preparation,
request-hash, attempt, persistence, and scoring variant. These scripts contain
valuable learned safeguards, but the safeguards are not reusable enforcement.

There is duplication inside the reusable package too:

- The root CLI and ComfyUI nodes independently load credentials, construct
  clients, invoke the router, and shape run metadata
  ([`cli.py`](../../qwen_ui_pipeline/cli.py#L199-L226),
  [`comfyui_node.py`](../../qwen_ui_pipeline/comfyui_node.py#L111-L165)).
- The Partner path and legacy path deliberately have different validation and
  metadata behavior. Compatibility is legitimate, but their shared runner
  responsibilities are implicit.
- The artifact writer, run-manifest validator, and paid-attempt ledger each own
  part of “what a run is,” with no interface composing the three.
- Qwen and Seedance both hash/sanitize requests and write evidence, but use
  different data shapes, durability rules, and error semantics.

### Application material in the tool repository

The tool repository contains large application-owned bodies: `godot/`, 523
tracked artifact/reference/evidence files, saved application workflows, and
hard-coded one-off assembly scripts. For example,
`assemble_museum_filter_v002.py` owns museum-window coordinates, donor choices,
and exact application composition rather than a reusable Assembly interface
([`assemble_museum_filter_v002.py`](../../scripts/assemble_museum_filter_v002.py#L101-L179)).
Root workflow tests likewise use PlantStudio and GolfStudio filenames and
coordinates as fixtures ([`test_comfyui_workflow.py`](../../tests/test_comfyui_workflow.py#L14-L47)).

Those examples are useful acceptance fixtures until equivalents exist, but the
assets, generations, Assembly outputs, application builds, and application
learnings belong with the application repository under the agreed “one tool
GitHub, one application GitHub” topology. Moving them cannot mean deleting
provenance: tool tests need small, licensed fixtures or hash-addressed pointers,
and historical run identities must remain resolvable.

Seedance is different from a single application accumulation. It is already a
self-contained second tool with its own package, tests, docs, schemas, skills,
ComfyUI nodes, and evidence. That supports the owner's view that it may become a
separate repository later. This research makes no move and does not integrate
the separate testing map.

## Working depth worth preserving

These are functioning seams, not pass-through code:

1. **Edit Brief compilation and provider adapters** — shared semantic prompt
   compilation plus explicit OpenRouter/Alibaba translations.
2. **Partner reference/control preflight** — named reference roles, input
   hashes, capability-aware rejection before billing, and portable visible
   ComfyUI controls.
3. **Assembly and deterministic fidelity** — exact-region ownership, fail-closed
   contract parsing, zero-unlicensed-pixel evidence, and separate palette drift.
4. **Evidence safety** — embedded-input redaction, output hashing, strict
   manifest semantics, secret/path rejection, atomic no-retry sentinels, and
   bounded independent review.
5. **Seedance lifecycle gates** — live capability binding, no silent model
   switch, actual-reference inclusion, request digest and canonical-model lock,
   exact cost acknowledgement, resumable job ID, and media verification.

The ComfyUI registration wrapper and saved workflow JSON are adapters and
examples. Issue-specific scripts, application coordinates, generated evidence,
and builds are not reusable module implementations, even when they contain
learnings that should be promoted into one.

## Constraints for the Wayfinder map

The next decisions should be made against these facts:

- Define one run-lifecycle interface that must establish identity and durable
  pre-submission evidence before any provider side effect, then always terminate
  in either completed evidence or classified failure evidence.
- Decide whether image and video use one versioned Run Record envelope with
  mode-specific extensions, or two records sharing an event/error/provenance
  protocol. The current shapes should not simply be renamed and declared done.
- Make reference identity machine-readable and prove that the exact locked
  reference enters the provider payload. Seedance demonstrates this for video;
  Partner Qwen demonstrates named image roles and hashes.
- Represent Assembly as an executable required stage for tasks whose contract
  calls for deterministic composition, and make checks a completion gate rather
  than optional follow-up calls.
- Preserve provider adapters and compatibility nodes behind the new runner;
  move application materials only after provenance and replacement test
  fixtures are specified.

Effect and TDD can help at the orchestration seam, but this report does not pick
an implementation. A plausible public shape would make Runner depend explicitly
on Provider, Filesystem, Clock, and Ledger services and return declared errors as
values; the acceptance tests should sit at the runner, validator, Assembly, and
Run Record seams. Those seams need a Wayfinder decision before tests are written.

## Decision gist

Preserve the existing provider, reference-validation, Assembly, fidelity,
evidence, and Seedance kernels; the cleanup should make them modules behind one
fail-closed run procedure, because today they are strong but optional islands
surrounded by duplicated experiment and application code.
