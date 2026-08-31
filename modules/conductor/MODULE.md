# Conductor

- Purpose: Give an application agent one normal planning path and one classified answer.
- Interface: `modules/conductor/index.ts`
- Errors: `modules/conductor/errors.ts`
- Acceptance: `modules/conductor/conductor.test.ts`

`plan` discovers the fixed Project Contract and Tool Lock, reads one application-relative Objective, delegates evidence and contract proof, and returns either a Planned Run or a refusal. Both results contain the five-question Normal View. Planning has no Generation, credential, network, Run Record writer, attempt reservation, clock, or randomness capability.

`advance` is the single execution interface for the Qwen Assembly tracer bullet. It prepares the exact locked reference payload, reserves and marks one Run, spends its one-use Submission Permit through Generation, persists provider and donor evidence, and stops at a genuine donor-choice decision. Supplying the selected persisted SHA-256 resumes that same Run without Generation, reads verified baseline and donor evidence, performs deterministic Assembly, runs the ordered Fidelity Checks, persists their evidence, and returns a Verified Candidate. The plain Normal View stays separate from the complete replay-derived Run Record diagnostics.

This tracer bullet consumes normalized RGBA raster evidence at the Assembly seam. Decoding ordinary image media into that normalized evidence is a separate adapter responsibility and is not hidden inside Conductor.
