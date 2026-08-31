# Generation

- Purpose: Prove the locked references reach the exact provider payload locations and invoke one normalized adapter through one Submission Permit.
- Interface: `modules/generation/index.ts`
- Errors: `modules/generation/errors.ts`
- Acceptance: `modules/generation/generation.test.ts`

Generation prepares a deterministic provider payload before reservation and exposes its SHA-256. Invocation requires the one-use Run Record Submission Permit. Provider output remains donor evidence; Generation cannot declare a Verified Candidate, perform Assembly, or write the application Run Record.
