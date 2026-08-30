# Conductor

- Purpose: Give an application agent one normal planning path and one classified answer.
- Interface: `modules/conductor/index.ts`
- Errors: `modules/conductor/errors.ts`
- Acceptance: `modules/conductor/conductor.test.ts`

`plan` discovers the fixed Project Contract and Tool Lock, reads one application-relative Objective, delegates evidence and contract proof, and returns either a Planned Run or a refusal. Both results contain the five-question Normal View. Planning has no Generation, credential, network, Run Record writer, attempt reservation, clock, or randomness capability.
