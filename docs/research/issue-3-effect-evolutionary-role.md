# Issue 3: the smallest evolutionary role for TypeScript Effect

Issue: [Research: find the smallest evolutionary role for TypeScript Effect](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/3)

## Decision

Use TypeScript Effect for **one new run-control module**, after a
language-neutral run protocol is frozen. Keep the existing Python and ComfyUI
implementations as adapters behind that module. Do not rewrite provider,
generation, Seedance, Assembly, or fidelity algorithms in TypeScript, and do
not wrap every Python function in Effect.

The first public seam should be one operation conceptually shaped like:

```text
execute(run request)
  -> run outcome
  !  typed run error
  <- run store + clock + image runner + video runner + assembly runner
```

The request, emitted events, terminal outcome, and retry disposition must cross
the Python/TypeScript seam as versioned JSON, not as TypeScript-only objects.
The exact run-record fields and state transitions belong in the run-record
specification, not in this research decision.

This is the smallest role that makes Effect earn its additional runtime. A
schema-only Effect CLI would validate files but would not enforce the sequence
that currently matters: pre-submit record, one submission, durable response or
failure, explicit retry classification, required Assembly, and checks. A broad
TypeScript rewrite would contradict the source architecture decision that new
work uses Effect while Python remains Python
([agentic-workflow ADR 0005](https://github.com/Reid-Surmeier/agentic-workflow/blob/b55b7c8859adbdcc86263c40da4ad2b14b12122f/docs/adr/0005-modules-with-intact-seams-and-effect-in-new-typescript.md#L24-L29)).

## Sources and baselines

- Pipeline baseline:
  [`b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b`](https://github.com/Reid-Surmeier/qwen-image-pipeline/tree/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b).
- Module template baseline:
  [`agentic-workflow@b55b7c8`](https://github.com/Reid-Surmeier/agentic-workflow/tree/b55b7c8859adbdcc86263c40da4ad2b14b12122f/new-repo).
- The template pins `effect` exactly at `4.0.0-rc.112` and requires Node 22 or
  newer
  ([package.json](https://github.com/Reid-Surmeier/agentic-workflow/blob/b55b7c8859adbdcc86263c40da4ad2b14b12122f/new-repo/package.json#L18-L30)).
- The checked-in template does not carry a generated `repos/effect` directory;
  the `new-repo` procedure vendors it after copying the template, at the ref
  derived from that exact package pin
  ([new-repo procedure](https://github.com/Reid-Surmeier/agentic-workflow/blob/b55b7c8859adbdcc86263c40da4ad2b14b12122f/skills/engineering/new-repo/SKILL.md#L22-L32)).
  To inspect the same source without modifying either repository, this research
  used a temporary read-only checkout of the matching upstream tag.
- Effect source and tests were read at the matching tag commit
  [`2600f62`](https://github.com/Effect-TS/effect/tree/2600f62f4532026928454dcea8d1c48557b3f942).

## What the inherited code already proves

The repository already has useful internal pieces. The problem is that they do
not form one mandatory execution path.

- Qwen's main CLI constructs provider clients from environment variables,
  calls the provider router, and writes a legacy run bundle directly
  ([CLI](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/qwen_ui_pipeline/cli.py#L199-L226)).
- Provider fallback accepts untyped clients and decides whether to fall back by
  matching text inside a `RuntimeError`
  ([router](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/qwen_ui_pipeline/providers/router.py#L19-L50)).
- A crash-safe paid-attempt sentinel already writes `retry_allowed: false`
  before submission and refuses duplicate evidence
  ([ledger](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/qwen_ui_pipeline/paid_attempts.py#L65-L97)),
  but it is not called by the main Qwen CLI.
- The run-manifest validator already distinguishes probabilistic Render Passes
  from deterministic Assembly and rejects provider metadata on Assembly
  ([validator](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/qwen_ui_pipeline/run_manifest.py#L161-L210)),
  but the main CLI writes its separate `brief.json`, `request.json`,
  `response.json`, and `run.json` bundle without invoking that validator
  ([artifact writer](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/qwen_ui_pipeline/providers/openrouter.py#L232-L285)).
- Assembly exists as a separate deterministic ComfyUI workflow builder
  ([Assembly workflow](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/qwen_ui_pipeline/comfyui_workflow.py#L39-L72));
  generation does not require that stage to run.
- Seedance planning correctly hashes the payload and records an estimate before
  submission
  ([plan](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/seedance/src/seedance_icons/cli.py#L72-L113)).
  Submission marks `paid_submission_performed` only after the provider returns
  and `job.json` is written
  ([submit](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/seedance/src/seedance_icons/cli.py#L121-L161)).
  Therefore, an exception after the request leaves no durable pre-submit state
  proving that the request may already have been spent. This is an inference
  from the ordering in the cited code.

The repository architecture already says the final strict-preservation path is
two-stage generation followed by deterministic region Assembly
([ADR 0002](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/docs/adr/0002-preserve-immutable-pixels-with-region-assembly.md)).
The missing depth is therefore orchestration, not another rendering
implementation.

## What Effect contributes at that seam

The template's module pattern freezes the public interface, tagged errors, and
acceptance tests while leaving implementation free
([module template](https://github.com/Reid-Surmeier/agentic-workflow/blob/b55b7c8859adbdcc86263c40da4ad2b14b12122f/new-repo/MODULE.template.md#L1-L22)).
It also enforces imports through module `index.ts` files and rejects cycles and
imports from vendored source
([seam lint](https://github.com/Reid-Surmeier/agentic-workflow/blob/b55b7c8859adbdcc86263c40da4ad2b14b12122f/new-repo/.dependency-cruiser.cjs#L1-L27)).

At the pinned version, `Effect<A, E, R>` makes success, error, and required
services separate type parameters
([Effect source](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/Effect.ts#L105-L123)).
The template demonstrates the intended use directly: a public function names
its `Greeting`, `EmptyName`, and `Clock` contract
([example interface](https://github.com/Reid-Surmeier/agentic-workflow/blob/b55b7c8859adbdcc86263c40da4ad2b14b12122f/new-repo/modules/example/index.ts#L1-L11));
tagged errors support discriminated recovery
([Effect `TaggedError`](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/Data.ts#L716-L765));
and services can be replaced with test Layers
([template acceptance test](https://github.com/Reid-Surmeier/agentic-workflow/blob/b55b7c8859adbdcc86263c40da4ad2b14b12122f/new-repo/modules/example/example.test.ts#L8-L21),
[Layer source](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/Layer.ts#L780-L815)).

That is useful at the run-control seam because the caller can see, in one
contract, whether a run requires a run store, image runner, video runner,
Assembly runner, clock, or other adapter, and which terminal errors remain.
It does not make Python exceptions typed. The adapter must decode the JSON
protocol into typed values and map process/protocol failures into declared
errors. Effect Schema supports exactly that kind of `unknown`-input decoder,
returning an Effect with a schema error channel
([Schema source](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/Schema.ts#L1495-L1524)).

Effect interruption is not a billing guarantee. Its Promise adapter aborts a
provided signal on interruption only if the underlying operation observes the
signal
([Effect source](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/Effect.ts#L920-L973),
[test](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/test/Effect.test.ts#L439-L448)).
Its timeout produces a typed `TimeoutError` and interrupts the source effect
([timeout source](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/Effect.ts#L4505-L4549)),
but a provider may already have accepted and billed a request. The control
plane must therefore record the attempt before starting the adapter and map a
timeout to an ambiguous, non-retryable outcome until reconciliation. Generic
Effect retry must never wrap paid submission.

## Options compared

| Option | Module depth | Interoperability | Operational cost | Testability | Migration cost | Rule enforcement |
| --- | --- | --- | --- | --- | --- | --- |
| Python-only contracts | Can produce deep Python modules, especially with `Protocol`, dataclasses, explicit result values, and the existing dependency injection style. Python's type system will not place a checked error channel and required services together in every public return type. | Best: no process or language seam; native access to existing provider, Pillow, media, and ComfyUI code. | Lowest: Python remains the only application runtime. | Existing tests already inject fake provider clients and verify durable ledger behavior ([provider test](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/tests/test_provider_fallback.py#L28-L60), [ledger test](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/tests/test_paid_attempts.py#L11-L45)). Static error and dependency coverage would remain conventional rather than Effect-typed. | Lowest. Existing behavior can be reorganized gradually. | Strong only if one Python coordinator becomes mandatory. Types alone do not prevent a second CLI from bypassing it. |
| TypeScript Effect run-control over Python adapters | Deep at the highest-leverage seam: it owns lifecycle and policy, while algorithms stay deep in Python. It should begin as one module, not one module per current file. | Requires a versioned JSON/JSONL process contract. Python/ComfyUI stay callable without being imported into Node. Protocol versioning and error translation are new obligations. | Medium: Node 22+, the exact Effect pin, TypeScript build/test/lint, Python, and adapter process supervision must all ship. The template's full `check` command adds type, seam, test, map, gate, and vendored-source checks ([package scripts](https://github.com/Reid-Surmeier/agentic-workflow/blob/b55b7c8859adbdcc86263c40da4ad2b14b12122f/new-repo/package.json#L7-L20)). | Highest for lifecycle rules: test Layers can simulate accepted, ambiguous, failed, recovered, assembled, and verified outcomes without provider calls. Python adapter behavior remains tested in Python. Cross-language contract fixtures are required. | Medium when introduced as one vertical slice; high if it becomes a rewrite. | Strongest: the only successful terminal path can require all declared stages and records. This benefit, not typed syntax alone, justifies the control plane. |
| Effect schema gate only | Shallow: a small TS CLI decodes a run request or bundle and returns validation errors. | Simple file/stdin JSON exchange; no long-running process supervision. | Low-to-medium: still adds Node 22, Effect, vendored source, and TypeScript gates for one validator. | Good for data shape and invariants; poor for ordering, one-submit behavior, crash recovery, or mandatory Assembly. | Low. It can be added without rerouting execution. | Insufficient as the destination. Existing CLIs can still skip the gate or validate only after an unsafe effect. |

## Evolutionary sequence

1. **Freeze the protocol before choosing implementation detail.** Specify one
   versioned run request, append-only event vocabulary, terminal outcome, and
   retry disposition that both Qwen image and Seedance video can represent.
   Preserve provider-specific fields in explicit extensions rather than a
   catch-all untyped object.
2. **Build one vertical control slice.** Route a no-cost fake image run through
   `run-control`: validate request, create the durable attempt record, invoke a
   fake Python adapter, persist events and terminal outcome, require Assembly
   when the request declares it, and require checks before success. This is the
   first point at which Effect is introduced.
3. **Adapt, do not port.** Add narrow machine interfaces to the existing Python
   Qwen and Seedance entry points. Their provider request construction,
   capability checks, media processing, ComfyUI workflow construction,
   Assembly, and fidelity logic stay in Python.
4. **Move paid entry points behind the control seam.** Only after fake and
   failure-path acceptance tests pass should the existing submission commands
   delegate to `run-control`. A compatibility command may remain, but it may
   not retain a second direct provider path.
5. **Split modules only when depth appears.** The likely later modules are run
   contract, run store, and policy/verification. Do not declare provider,
   logging, Assembly, and every validator separate TypeScript modules before
   the first slice proves their interfaces.

## Acceptance-test seams for the later TDD specification

No tests are added by this research ticket. The implementation specification
should freeze these seams before its first red-green cycle:

- **Run-control public interface:** a valid request can reach exactly one
  terminal outcome; an invalid request invokes no adapter.
- **Run-store service:** the attempt/event record is durable before the paid
  adapter starts; an existing ambiguous attempt blocks submission.
- **Runner adapter protocol:** Qwen and Seedance fixtures translate the same
  versioned envelope into typed outcomes while preserving provider-specific
  evidence.
- **Assembly/verification policy:** a run that declares Assembly cannot become
  successful from raw generation output, and exact-preservation success
  requires the deterministic evidence already mandated by ADR 0002.
- **Crash/restart contract:** replaying the same run identity resumes or
  reconciles; it never silently creates a second paid request.

Each seam should be implemented as a vertical test slice with fake Layers and
fixture Python adapters. Existing Python tests continue to test provider and
media behavior through their current public interfaces.

## Rejected directions and limits

- **No Python rewrite.** The source ADR explicitly preserves Python, and the
  existing code contains working domain depth that a port would only risk.
- **No Effect in ComfyUI custom nodes.** ComfyUI is a Python host; use its
  existing Python nodes as an adapter surface.
- **No automatic paid retries.** Typed timeout, interruption, or process exit
  does not prove the provider did not accept a request.
- **No TypeScript-owned artifact schema.** JSON schemas and fixtures must be
  usable by Python and application repositories without importing this tool's
  TypeScript package.
- **No claim that Effect alone enforces policy.** Enforcement comes from making
  the new control seam the only provider-submission path and testing its state
  transitions. Effect makes that seam explicit and replaceable; architecture
  and migration make it authoritative.

## One-line answer

Introduce Effect only as a thin, mandatory run-control module over versioned
JSON Python/ComfyUI adapters; freeze the protocol first, migrate one fake
vertical slice, and never port the existing generation, Seedance, Assembly, or
verification implementations merely to obtain Effect types.
