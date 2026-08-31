# Conductor

- Purpose: Give an application agent one normal planning path and one classified answer.
- Interface: `modules/conductor/index.ts`
- Errors: `modules/conductor/errors.ts`
- Acceptance: `modules/conductor/conductor.test.ts`

If a sanitized Seedance submission response became write-once durable before its journal event, the next advance lets Run Record reconcile it during reservation reload and continues from the recovered job identity without another submission.

`plan` discovers the fixed Project Contract and Tool Lock, reads one application-relative Objective, delegates evidence and contract proof, and returns either a Planned Run or a refusal. Both results contain the five-question Normal View. Planning has no Generation, credential, network, Run Record writer, attempt reservation, clock, or randomness capability.

Planning refusals and execution terminals use exactly four Machine Outcomes: `verified_candidate`, `human_decision_required`, `blocked`, and `failed`. Every finding carries one correction owner from Reference Planning, Generation, Assembly, Verification, or the application decision owner. These machine results never contain or imply owner Approval.

`advance` is the single execution interface for both tracer bullets. For Qwen Assembly it prepares the exact locked reference payload, reserves and marks one Run, spends its one-use Submission Permit through Generation, persists provider and donor evidence, and always stops at a genuine donor-choice decision; a selection supplied before that checkpoint exists is deliberately ignored. If persistence stops after the provider receipt or after only part of the reserved output set, a later call passes that exact receipt through Generation recovery, replays already-written output operations, writes only the missing evidence, and never submits again. A later call supplying the selected persisted SHA-256 resumes that same Run without Generation, reads verified baseline and donor evidence, performs deterministic Assembly, runs the ordered Fidelity Checks, persists their evidence, and returns a Verified Candidate.

For Seedance, the first advance submits exactly once and returns `ProviderPending` only after the sanitized response and job identity are durable. Each later advance polls that same identity once; a pending response is recorded and returned, while a completed response atomically records the poll, complete output set, count, hashes, and cost state. If a pending body became durable before its event and the provider has since completed, the Conductor accepts Run Record's recovery of that first pending receipt, returns `ProviderPending`, and polls the same job again on the next advance. It then reads completed persisted bytes, invokes independent Video Verification against the immutable Video Plan, persists `checks.json`, and returns a Verified Candidate. No Seedance continuation can acquire a second Submission Permit. Every Normal View preserves the canonical objective and stays separate from replay-derived diagnostics.

Ambiguous provider results, malformed paid evidence, output-count mismatch, and interrupted post-submit persistence return a clear Blocked or Failed result without another adapter submission. Repeated advance reloads the same Run Record outcome. Possibly-spent or unknown work is reconciliation-only: it may continue an already-persisted provider identity or recover matching evidence, but it never creates a new paid Run.

This tracer bullet consumes normalized RGBA raster evidence at the Assembly seam. Its fake fixture advertises those JSON bytes as `application/vnd.qwen.rgba+json`, never as PNG. Ordinary PNG remains exact hash-bound Generation evidence but is not silently presented as Assembly-ready; decoding it into normalized evidence remains an explicit adapter responsibility outside this tracer bullet.
