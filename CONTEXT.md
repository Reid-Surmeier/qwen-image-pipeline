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
The application-owned declaration of purpose, allowed operations, evidence sources, output destinations, approval rules, and compatible tool version.
_Avoid_: Repository folklore, setup notes

**Objective**:
The application-owned, machine-readable statement of one desired result, selected Procedure, count, budget, and proposed evidence.
_Avoid_: Issue comment, prompt fragment

**Tool Lock**:
The application-owned exact identity of the compatible tool release, commit, artifact, Procedure, Run schema, and adapter protocol.
_Avoid_: Latest branch, compatible-enough version

**Reference Plan**:
The proved mapping from authoritative application media to exact provider-payload destinations, including application-relative paths, hashes, detected kinds, inspected properties, and authority reasons.
_Avoid_: Reference list, Markdown attachment

**Run Request**:
The canonical provider-independent instructions produced from a valid Objective, Project Contract, Tool Lock, and Reference Plan.
_Avoid_: Provider payload, loose request blob

**Planned Run**:
An immutable, hash-identified Run Request that passed planning but has not reserved an attempt or called Generation.
_Avoid_: Attempt, submitted job

**Linked Run**:
A distinct Planned Run whose canonical Run Request names one parent Run and its exact definitive pre-submit failure event.
_Avoid_: Retrying the same Planned Run, reservation-time parent override

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
- One durable submission-may-have-started event may issue one in-process **Submission Permit**; replay issues none.
- A definitively failed pre-submit **Run Record** remains immutable and may be named by a distinct **Linked Run** whose relationship is fixed in its Run Request before reservation.

## Example dialogue

> **Designer:** “Keep the Reference Screen's spacing and visual hierarchy, but replace the flower with a golf club.”
> **Developer:** “I’ll encode those as Preservation Invariants, run a focused Asset Pass for the club, assemble the approved asset and Exact Copy, then validate the Interactive Replica.”

## Flagged ambiguities

- “Prompt” previously meant both an unstructured sentence and the complete controlled input. Resolved: user intent is an **Edit Brief**; the provider prompt is compiled from it.
- “Stitching” obscured the difference between generating pixels and placing approved elements. Resolved: deterministic placement is **Assembly**.
- “No drift” previously mixed visual similarity with pixel identity. Resolved: strict preservation means a Fidelity Check reports zero changed pixels outside declared edit regions; similarity metrics remain useful for ranking generative donor images.
