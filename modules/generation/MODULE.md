# Generation

- Purpose: Submit validated requests to the locked provider adapter and return normalized provider evidence and raw outputs.
- Interface: `modules/generation/index.ts`
- Errors: `modules/generation/errors.ts`
- Acceptance: `modules/generation/generation.test.ts`

Generation manages one-time provider adapter invocations, payload reference destination checks, response sanitization, and output extraction without leaking credentials.
