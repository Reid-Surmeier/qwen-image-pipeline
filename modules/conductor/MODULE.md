# Conductor

- Purpose: Give an application agent one normal planning path and one classified answer.
- Interface: `modules/conductor/index.ts`
- Errors: `modules/conductor/errors.ts`
- Acceptance: `modules/conductor/conductor.test.ts`

`plan` discovers the fixed Project Contract and Tool Lock, reads one application-relative Objective, delegates evidence and contract proof, and returns either a Planned Run or a refusal. Both results contain the five-question Normal View. Planning has no Generation, credential, network, Run Record writer, attempt reservation, clock, or randomness capability.

`advance` is the single execution interface for the Qwen Assembly tracer bullet. It prepares the exact locked reference payload, reserves and marks one Run, spends its one-use Submission Permit through Generation, persists provider and donor evidence, and always stops at a genuine donor-choice decision; a selection supplied before that checkpoint exists is deliberately ignored. A later call supplying the selected persisted SHA-256 resumes that same Run without Generation, reads verified baseline and donor evidence, performs deterministic Assembly, runs the ordered Fidelity Checks, persists their evidence, and returns a Verified Candidate. Every Normal View preserves the canonical Run Request objective verbatim. The plain Normal View stays separate from diagnostics read through the Run Record's replay-derived diagnostic interface.

This tracer bullet consumes normalized RGBA raster evidence at the Assembly seam. Its fake fixture advertises those JSON bytes as `application/vnd.qwen.rgba+json`, never as PNG. Ordinary PNG remains exact hash-bound Generation evidence but is not silently presented as Assembly-ready; decoding it into normalized evidence remains an explicit adapter responsibility outside this tracer bullet.
