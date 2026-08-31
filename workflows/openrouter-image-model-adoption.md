# OpenRouter image model adoption

## Purpose

Turn one reviewed OpenRouter image-model request into a released, explicitly
selectable Model Profile with deterministic evidence and bounded paid proof.
Run the workflow once per model. The active order is Nano Banana 2, Grok
Imagine Image 2.0, then Krea 2 Medium Turbo.

## Trigger

An authoritative ready Issue supplies:

- the official OpenRouter model URL;
- requested capabilities and exclusions;
- the target release;
- the maximum paid output count and spend ceiling;
- the predecessor model Issue whose completion unlocks this run.

Chat can clarify an Issue but cannot trigger implementation by itself. A
scheduled sweep may notice the Issue; it must not bypass readiness or ordering.

## Inputs

- Active Issue and acceptance criteria.
- Exact predecessor release evidence, when this is not the first queued model.
- Current build branch and draft build pull request.
- Official public OpenRouter model, endpoint, routing, privacy, pricing, and
  lifecycle records.
- One neutral text-to-image fixture.
- One neutral single-reference edit fixture with immutable source bytes.
- Canonical `OPENROUTER_API_KEY` logical credential available only at the paid
  submission seam.

## Workflow

1. **Establish identity**
   - Recheck the Issue, repository, build branch, pull request, requested model,
     predecessor, and output allowance.
   - Refuse when another model is active or the predecessor is not released.
   - Pin the request slug, permanent identity when exposed, exact provider
     endpoint, fallback policy, lifecycle status, and friendly display label.

2. **Lock the Model Profile**
   - Fetch official public capability, privacy, and pricing records without a
     credential.
   - Canonicalize and hash the evidence.
   - Record supported and absent controls, reference and count limits, provider
     route, retention policy, and price assumptions.
   - Refuse drift, deprecation, an unavailable explicit route, fallback, or a
     control the endpoint does not advertise.

3. **Specify and prototype**
   - Freeze the Image Plan, generic image receipt, named refusal outcomes,
     historical replay, Assembly rule, CLI selection, and ComfyUI compatibility
     contracts before production code.
   - Exercise the state model in a no-network logic prototype covering text
     generation, reference editing, drift, unsupported controls, fallback,
     duplicate submission, and ambiguous billing.
   - Capture the prototype on a throwaway branch and carry only validated
     decisions into production.

4. **Implement without spending**
   - Work test-first through frozen public seams on the one current build line.
   - Add or version Model Profile, Run Contract, Generation, provider receipt,
     Run Record, Conductor, CLI, and generic ComfyUI delegation only where the
     specification requires.
   - Preserve historical readers and saved Qwen workflows.
   - Use fake and captured responses in the canonical deterministic baseline;
     ordinary CI has no credential or provider access.

5. **Prepare paid qualification**
   - Require the exact implementation commit and deterministic baseline to pass.
   - Freeze the two qualification requests, fixtures, reference hashes, provider
     route, profile digest, estimated cost, count, timeout, stop rule, and
     request digests in application-owned Run Records.
   - Recheck the live official Model Profile evidence. Any drift invalidates the
     prepared request before reservation.

6. **Run paid proof**
   - Submit exactly one text-to-image Run and one single-reference edit Run
     through OpenRouter.
   - Durably reserve each attempt and mark submission-may-have-started before
     network I/O.
   - Persist sanitized raw responses, returned media, dimensions, hashes, token
     usage, actual cost or `unknown`, timestamps, and elapsed time.
   - Never submit the same Run twice. Ambiguous state freezes this workflow and
     every later model until reconciled.

7. **Verify and review**
   - Run integrity, count, media, reference-placement, Assembly/fidelity when
     required, task-specific deterministic, and independent semantic checks.
   - Produce visual proof in the build pull request.
   - Prepare the final owner brief. The owner records Approval separately from
     the machine outcome.

8. **Release and advance the queue**
   - Require current exact-head ship review and the repository release gates.
   - Release by the version tag; do not treat a branch, commit, or provider
     success as completion.
   - Only the completed tag and paid evidence unblock the next model Issue.

## Checkpoint

Push the normal owner checkpoint to the end. Present one decision-ready brief
containing:

- exact release SHA and tag;
- Model Profile, provider endpoint, and capability-evidence identities;
- the two paid outputs beside their references;
- deterministic, independent, and visual findings;
- requested and completed counts;
- estimated and actual cost plus elapsed time;
- unresolved limitations or ambiguous spend;
- whether the next queued model is unblocked.

Stop earlier only for ambiguous possible spending, credential failure,
contradictory verification, unverifiable preservation, or a genuinely
subjective choice that changes execution.

## Failure and recovery

- A pre-reservation refusal spends nothing and may create a newly planned Run
  only after the governing evidence changes.
- A reserved or submitted Run is immutable.
- A timeout, transport loss, malformed paid response, or interrupted
  post-submit persistence is possibly spent and reconciliation-only.
- Reconciliation may recover only the recorded provider identity and existing
  response or output. It never creates a second submission.
- A failed deterministic gate prevents paid qualification or later paid review.
- A missing release or unresolved predecessor keeps later models blocked.

## Done

The workflow is complete only when the model is implemented on the authorized
build line, the canonical deterministic baseline passes, both required paid
Runs have complete evidence, visual proof is attached, exact-head review says
ship, the release tag exists, and the owner brief states whether the next model
is unblocked. Anything less is in progress, blocked, failed, or awaiting owner
Approval—not done.
