# Agentic Workflow v0.3.0 consequences for the successor (Issue #12)

Checked 2026-08-30 against the immutable `agentic-workflow` tag `v0.3.0`
(commit `1eb153db27875845990d53d883f4b400cd14af32`) and the successor baseline
`b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b`. The GitHub Release identifies
the tagged page as the authoritative human-facing summary
([release](https://github.com/Reid-Surmeier/agentic-workflow/releases/tag/v0.3.0),
[tagged release page](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/docs/releases/v0.3.0/RELEASE.md#L1-L13)).

## Decision gist

Adopt v0.3.0's one-build-branch/tag-release lifecycle before implementation,
keep the map's planning and application/tool separation, and make the chosen
module retrofit explicit: a thin Effect Conductor owns frozen contracts while
the inherited Python and ComfyUI kernels remain adapters rather than becoming a
rewrite.

## What v0.3.0 actually makes normative

### Issue work continues unless the owner applies the brake

An agent triages `needs-triage`, writes the decided scope into the Issue,
applies `ready-for-agent`, and continues. The only owner-controlled pause is
`needs-human-review`, and an agent must never apply that label. `needs-info`
is for a fact whose absence changes the result; `blocked` names a dependency
([tagged operating contract](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/AGENTS.md#L15-L20),
[tagged lifecycle](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/docs/agents/repository-workflow.md#L45-L62)).

This replaces both an Issue-level permission wait and a general pre-merge owner
gate. It does **not** remove a product-level human decision: the generation tool
may still return `human_decision_required` for donor choice or subjective final
visual approval. That state belongs to the application run procedure, not to
the tool repository's release mechanics.

### One build branch accumulates work; a tag is the release

Each repository has one `build/<version>` branch and one draft PR used as a CI
surface and changelog. Tickets normally commit directly to that line; a short
branch exists only for contention and is folded back the same day. A ticket
does not get its own PR
([repository workflow](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/docs/agents/repository-workflow.md#L53-L63),
[`implement`](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/skills/engineering/implement/SKILL.md#L11-L17)).

When the line reaches 20 commits or three days, `code-review` must record the
exact reviewed SHA and `verdict: ship`. The steward then pushes only the
`v<version>` tag. The Release workflow verifies that tag, merges it into
`main`, publishes `docs/releases/v<version>/RELEASE.md`, and closes the build
PR; the owner reads the release afterwards and can send a change back through
the steward's revert path
([release page](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/docs/releases/v0.3.0/RELEASE.md#L9-L13),
[`release-steward`](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/skills/engineering/release-steward/SKILL.md#L13-L19),
[fail-closed cut rules](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/docs/agents/repository-workflow.md#L125-L135)).

### Wayfinder remains planning, with a narrow research exception

Wayfinder resolves decision tickets rather than building the destination
unless the map Notes explicitly opt into execution. Tickets are claimed before
work, and no session resolves more than one ticket except research tickets
([tagged Wayfinder](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/skills/engineering/wayfinder/SKILL.md#L11-L17),
[claim and dependencies](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/skills/engineering/wayfinder/SKILL.md#L55-L71),
[session rule](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/skills/engineering/wayfinder/SKILL.md#L103-L126)).

Issue #12 carried only `wayfinder:research`, not `ready-for-agent`, when this
work began. Resolving it follows Wayfinder's explicit research-ticket path and
the map's already-used research exception; it must not become precedent for an
implementation ticket to skip v0.3.0 triage and readiness recording.

## Where the successor conflicts

| Area | Successor at `b2e4f594...` | v0.3.0 consequence |
| --- | --- | --- |
| Release identity | `release/v0.2.0` is the standing line; the owner declares it done and no agent merges it ([current contract](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/AGENTS.md#L59-L76)). | Replace this inherited milestone rule. The line is `build/<version>`; the reviewed tag and Release workflow move `main`; owner review is after publication. |
| Branch topology | One branch or worktree per coherent goal, starting from `main` ([current contract](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/AGENTS.md#L107-L115)); the longer workflow says one branch per Issue and opens a PR ([current workflow](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/docs/agents/repository-workflow.md#L86-L114)). | Implementation starts from the build branch, normally lands there directly, and has no ticket PR. Short worktrees are contention tools, not permanent issue topology. |
| Human pause | The successor says human approval is at the PR and requires it before merge, while `ready-for-agent` is merely descriptive ([current workflow](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/docs/agents/repository-workflow.md#L64-L84)). | Record the v0.3.0 labels exactly: triage writes the decision, applies `ready-for-agent`, and continues; only an owner-applied `needs-human-review` pauses repository work. |
| Paid work | The standing OpenRouter allowance says no per-Issue approval, but the PR gate still says paid execution needs human approval ([allowance](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/AGENTS.md#L126-L139), [PR gate](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/AGENTS.md#L166-L183)). | Remove the contradiction later. Keep this repo's tighter image-count and provenance controls, but make approval a spend-threshold or explicit owner-brake question, not an automatic PR permission gate. |
| Repository purpose | The contract still makes a Godot interactive replica and its 200-generation application milestone the repository goal ([current milestone](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/AGENTS.md#L78-L105)). | This is stale application-specific inheritance, not a v0.3.0 rule. Map #1 makes this the reusable tool and assigns Godot assets, generations, Assembly outputs, builds, and Run Records to an application repository. |
| Enforcement | The successor has no `build/*` PR, release workflow, release-train workflow, release page, module map, seam lint, or steward configuration in its baseline. Its workflow still names `Qwen-3-Pro-Pipeline` ([stale document](https://github.com/Reid-Surmeier/qwen-image-pipeline/blob/b2e4f594f6fb23e0dcc4e2a3395d492585a35c9b/docs/agents/repository-workflow.md#L1-L12)). | A prose-only rename would be false. A governance migration must install and prove the build/tag mechanics before feature implementation uses them. |

The successor's domain rules are not superseded merely because they are absent
from the shared release. OpenRouter-only routing, ambiguity-safe retry,
source hashes, deterministic Assembly, Fidelity Checks, and application-owned
visual approval remain valid repo-specific constraints. What changes is the
repository lifecycle around them.

## How the module discipline applies here

The shared v0.3.0 module rule freezes a module's interface, error types, and
acceptance tests; requires `MODULE.md`, a generated `MODULES.md`, and at least
Testing and Review modules; leaves existing Python in place; and says existing
repositories are retrofitted only when the owner directs it
([shared philosophy](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/souls/shared/PHILOSOPHY.md#L36-L43),
[accepted ADR](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/docs/adr/0005-modules-with-intact-seams-and-effect-in-new-typescript.md#L15-L31)).

The **new-repository template** makes that operational: every module has
`index.ts`, `errors.ts`, acceptance tests, and `MODULE.md`; cross-module imports
go only through `index.ts`; every public TypeScript function returns
`Effect<Success, Error, Requirements>`; dependencies are caller-provided
services; and a generated `MODULES.md` must remain current
([template contract](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/new-repo/AGENTS.md#L21-L29)). The template also includes distinct Testing and Review modules in its generated map
([template module map](https://github.com/Reid-Surmeier/agentic-workflow/blob/v0.3.0/new-repo/MODULES.md#L1-L11)).

Those sources do not order a wholesale Python port. This successor's map is the
owner-directed retrofit and already decides that Effect is the thin mandatory
run-control layer over a
versioned JSON protocol and existing Python/ComfyUI adapters
([Map #1](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/1),
[Effect decision](https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/3)).
The implementation specification therefore needs to freeze only the new public
seams and explicitly classify the retained kernels as adapters. Rewriting them
would contradict the map.

## Consequences the map and later tickets must absorb

1. **Governance before feature work.** Specify one migration ticket that
   creates `build/<version>` and its draft changelog PR, adds callable Verify
   plus tag Release/release-train enforcement, supplies release-page and review
   templates, and proves a dry-run refusal when review evidence is missing.
2. **One enforceable module map.** The architecture specification must name
   Conductor, adapters, Testing, and Review modules; freeze each interface,
   named errors, and acceptance tests; generate `MODULES.md`; and add a seam
   lint that rejects private cross-module imports. It must say which public
   calls use Effect and which inherited Python/ComfyUI code stays behind an
   adapter.
3. **Separate product gates from repository gates.** Human donor/final-visual
   decisions remain typed Conductor outcomes. Repository work pauses only on
   the owner's `needs-human-review`; paid authorization and provenance follow
   the explicit OpenRouter allowance without contradictory pre-approval text.
4. **Build tickets land on the line.** `to-spec`/`to-tickets` must make the
   governance migration a predecessor, then tell `implement` to land every
   tracer bullet on the current build branch with one changelog line and the
   integrated baseline. Research/prototype branches are evidence links, not a
   new permanent branch-per-ticket process.

The current map's planning-only note, one-tool/one-application split, and
decision-ticket structure agree with v0.3.0. Its inherited repository workflow
does not. The map can finish planning without installing the lifecycle, but its
handoff is not implementation-ready until the first migration ticket and its
blocking edges are explicit.
