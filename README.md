# qwen-image-pipeline

`qwen-image-pipeline` is a reusable tool for dependable image and video generation procedures. An autonomous agent working in an application repository should be able to plan the required evidence, invoke the right generation or deterministic Assembly operation, validate the result, and receive either a trustworthy classified result or a clear failure.

Application repositories own their references, assets, generations, Assembly outputs, run records, and builds. This repository owns the procedure contracts, provider adapters, validation, provenance rules, and agent guidance. One tool repository serves many application repositories without collecting their project artifacts.

## Current build

Development of the successor procedure happens on `build/v0.3.0` and is reviewed through one draft build pull request. The current inherited commands remain available while callers migrate; the governed planner/enforcer procedure described below is being completed ticket by ticket on that release line.

## Target normal path

1. An application supplies a machine-readable Project Contract and Run Request.
2. The planner identifies required evidence, references, hashes, and whether the task needs Generation, Assembly, or both.
3. The enforcer refuses unsafe or incomplete work before paid submission.
4. The runner reserves an attempt, calls the explicit provider adapter, and records events and raw responses.
5. Validators and deterministic Assembly produce a classified final result with provenance and a safe next action.

Subjective final visual approval remains human. Missing references, mismatched hashes, provider rejection, failed checks, ambiguous billing, and exhausted correction budgets become explicit outcomes rather than hidden agent judgment.

The machine returns exactly four terminal outcomes: Verified Candidate, Human Decision Required, Blocked, or Failed. A finding always names Reference Planning, Generation, Assembly, Verification, or the application decision owner as the correction owner. Possibly-spent or unknown work can only reconcile its existing provider identity and can never submit again. A distinct linked correction Run is available only after a definitive unspent pre-submit refusal, only for a material change, only as that parent's single reserved successor, and only inside the application-owned correction ceiling. Machine verification never records owner Approval.

See [`CONTEXT.md`](CONTEXT.md), the generated [`MODULES.md`](MODULES.md), and [`docs/adr/`](docs/adr/) for current vocabulary and accepted decisions. The map names only modules with frozen interfaces now; later #17 tickets add the remaining Conductor-led modules as they are implemented.
