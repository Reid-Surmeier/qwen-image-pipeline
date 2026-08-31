# Dependable Reference-Preserving Generation

This repository owns a reusable generation procedure, not any one application. Application repositories own their references, assets, generation and Assembly outputs, run records, and builds. The tool plans, enforces, executes, validates, and records work against application-owned inputs.

## Repository responsibility

- The **tool repository** defines contracts, procedure stages, adapters, checks, error classifications, provenance, and learnings.
- An **application repository** supplies the project contract, authoritative references, requested outcome, and destination for every resulting artifact.
- A run is complete only when it has a classified result, reproducibility evidence, and an explicit next action.

This context describes a repeatable system for transforming an existing interface or video while preserving authoritative evidence and producing trustworthy outputs.

## Language

**Reference Screen**:
The source interface image whose composition and visual relationships are authoritative.
_Avoid_: Inspiration image, loose reference

**Edit Brief**:
A structured description of intended changes to a Reference Screen.
_Avoid_: Prompt, request blob

**Preservation Invariant**:
A visual or semantic relationship that must remain unchanged during a Render Pass.
_Avoid_: Preference, suggestion

**Exact Copy**:
Text that must appear verbatim in the approved interface.
_Avoid_: Suggested wording, sample text

**Render Pass**:
One image-model invocation with a fixed Edit Brief, inputs, and seed.
_Avoid_: Attempt, random generation

**Asset Pass**:
A Render Pass that produces one isolated reusable interface element.
_Avoid_: Full-screen generation

**Screen Pass**:
A Render Pass that produces a composed interface view.
_Avoid_: Asset generation

**Assembly**:
The placement of approved assets and Exact Copy into a screen composition.
_Avoid_: Stitching

**Fidelity Check**:
A comparison of a Render Pass or Interactive Replica against the Reference Screen and Preservation Invariants.
_Avoid_: Vibe check

**Interactive Replica**:
A working software view derived from an approved screen composition.
_Avoid_: Screenshot, mockup

**Project Contract**:
The application-owned declaration of purpose, allowed operations, evidence sources, output destinations, artifact root, approval rules, and compatible tool version.
_Avoid_: Repository folklore, setup notes

**Objective**:
The application-owned, machine-readable statement of one desired result, selected Procedure, count, budget, and proposed evidence.
_Avoid_: Issue comment, prompt fragment

**Tool Lock**:
The application-owned exact identity of the compatible tool release, commit, artifact, Procedure, Run schema, and adapter protocol.
_Avoid_: Latest branch, compatible-enough version

**Installed Tool Artifact**:
The closed, hash-inventoried tool distribution whose release, commit, aggregate artifact digest, and version profile are verified from installed bytes before planning. It is the source of tool identity; an agent or caller cannot assert that identity.
_Avoid_: Branch name, working-tree claim, caller-provided version

**Reference Plan**:
The proved mapping from authoritative application media to exact provider-payload destinations, including application-relative paths, hashes, detected kinds, inspected properties, and authority reasons.
_Avoid_: Reference list, Markdown attachment

**Video Plan**:
The Seedance-only immutable proof that no authoritative pixel ownership requires Assembly, together with expected output dimensions, duration, and audio presence.
_Avoid_: “Assembly not needed” in prose, adapter default

**Run Request**:
The canonical provider-independent instructions produced from a valid Objective, Project Contract, Tool Lock, and Reference Plan.
_Avoid_: Provider payload, loose request blob

**Planned Run**:
An immutable, hash-identified Run Request that passed planning but has not reserved an attempt or called Generation.
_Avoid_: Attempt, submitted job

**Linked Run**:
A distinct Planned Run whose canonical Run Request names one parent Run and its exact definitive pre-submit failure event. It is permitted only when no submission started, changes material objective, reference, model, Procedure, or parameter evidence, and remains inside the Project Contract's fixed correction limit.
_Avoid_: Retrying the same Planned Run, reservation-time parent override

**Reconciliation**:
Continuing only the already-recorded provider identity and durable evidence of one possibly-spent or unknown Run. Reconciliation may poll, recover, or finish persistence for that identity; it never authorizes another submission or a successor Run.
_Avoid_: Retry, regenerate, submit again

**Machine Outcome**:
Exactly one of `verified_candidate`, `human_decision_required`, `blocked`, or `failed`, derived from replayable evidence rather than agent confidence.
_Avoid_: Done, looks good, probably failed

**Finding**:
The evidence-backed reason for a non-success Machine Outcome, including its stable class, safe message, and one Correction Owner.
_Avoid_: Raw provider exception, unowned error

**Correction Owner**:
Exactly one of Reference Planning, Generation, Assembly, Verification, or the application decision owner. It identifies where the evidence says correction belongs; it does not authorize spend or Approval.
_Avoid_: Whoever is available, the agent

**Approval**:
The application owner's separate subjective acceptance of a Verified Candidate. No Machine Outcome, check result, or agent statement can create Approval.
_Avoid_: Verified Candidate, tests passed

**Learning Proposal**:
A hash-locked, review-only generalization from complete Run provenance, positive evidence, and independently caught known-bad evidence. It names scope, affected seam, compatibility risk, and excluded application detail but cannot change a Procedure, interface, error, test, or application lock.
_Avoid_: Self-modifying rule, application anecdote

**Review Packet**:
The hash-locked plain-language bundle of one acceptance contract, exact Run Request and event head, references, candidate, instructions, deterministic verification evidence, and unresolved human decisions. Any changed Run, reference, candidate, or packet content invalidates it; machine verification remains separate from Approval.
_Avoid_: Screenshot alone, implementer narration

**Normal View**:
The plain-language account of the objective, evidence, next action, spend risk, and remaining human decision returned for every planning result.
_Avoid_: Debug dump, success banner

**Run Record**:
The append-only application-owned evidence for one reserved attempt, including request, events, raw provider response, outputs, checks, failure, and provenance.
_Avoid_: Console log, scratch folder

**Attempt Reservation**:
The first durable Run Record event. It fixes the immutable request, attempt identity, payload digest, estimated maximum cost, maximum count and spend, and conservative retry state before submission can begin.
_Avoid_: In-memory intent, provider call counter

**Submission Permit**:
A one-use, non-serializable capability returned only after the submission-may-have-started event is durable. Reload never recreates it.
_Avoid_: Retry token, persisted credential

## Relationships

- One **Reference Screen** has one or more **Edit Briefs**.
- An **Edit Brief** declares **Preservation Invariants** and **Exact Copy**.
- An **Edit Brief** produces one or more **Render Passes**.
- **Asset Passes** and **Screen Passes** feed **Assembly**.
- **Fidelity Checks** gate both **Assembly** and the **Interactive Replica**.
- One **Planned Run** may create one **Attempt Reservation** in one **Run Record**.
- One application **Project Contract** owns one artifact root. The production reader and writer accept only that application root; the tool repository owns no application references, outputs, Assembly evidence, Run Records, approvals, retention, or cleanup.
- A **Tool Lock** is exact per application. Updating one application's checked release does not update another, and replay interprets old Run Records through their own recorded Procedure, Run schema, and adapter protocol versions.
- A **Tool Lock** must exactly match one verified **Installed Tool Artifact** before planning. Before every advancement, the artifact bytes are reverified and the current **Project Contract**, selected **Procedure**, Tool Lock, and immutable Planned Run must still agree on application ownership, model, mode, provider, versions, count, cost, budget, paths, and reference requirements; the current Run Request schema is `1/2/1`, while historical `1/1/1` records retain their original shape.
- One durable submission-may-have-started event may issue one in-process **Submission Permit**; replay issues none.
- One Seedance **Submission Permit** may create one persisted provider job identity; every later advance polls only that identity and cannot submit another job.
- A definitively failed pre-submit **Run Record** remains immutable and may be named by a distinct **Linked Run** whose relationship is fixed in its Run Request before reservation.
- A **Linked Run** increments its replayed correction depth; a child cannot change the application or raise the inherited correction ceiling.
- Possibly-spent or unknown work permits **Reconciliation** of its existing provider identity only. Ambiguity, malformed paid evidence, and output-count symptoms become the evidence-backed `submission_unreconciled` finding unless exact provider evidence proves more; they and interrupted post-submit persistence never authorize another paid submission. Repetition means verified failures across linked Runs, never multiple unverified artifacts in one Run; the inherited correction ceiling stops it. Budget exhaustion fails before reservation.
- Every terminal result has one **Machine Outcome**. Every failure **Finding** names one **Correction Owner**, while **Approval** remains separate and human-owned.

## Example dialogue

> **Designer:** “Keep the Reference Screen's spacing and visual hierarchy, but replace the flower with a golf club.”
> **Developer:** “I’ll encode those as Preservation Invariants, run a focused Asset Pass for the club, assemble the approved asset and Exact Copy, then validate the Interactive Replica.”

## Flagged ambiguities

- “Prompt” previously meant both an unstructured sentence and the complete controlled input. Resolved: user intent is an **Edit Brief**; the provider prompt is compiled from it.
- “Stitching” obscured the difference between generating pixels and placing approved elements. Resolved: deterministic placement is **Assembly**.
- “No drift” previously mixed visual similarity with pixel identity. Resolved: strict preservation means a Fidelity Check reports zero changed pixels outside declared edit regions; similarity metrics remain useful for ranking generative donor images.
