# Generation

- Purpose: Prove the locked references reach the exact provider payload locations and invoke one normalized adapter through one Submission Permit.
- Interface: `modules/generation/index.ts`
- Errors: `modules/generation/errors.ts`
- Acceptance: `modules/generation/generation.test.ts`

Generation prepares a deterministic provider payload before reservation, verifies that each evidence media type equals the inspector-locked media type and matches its exact image or video payload location, and exposes the immutable request and payload SHA-256 values. Invocation requires a one-use Run Record Submission Permit bound to both digests; another Run or altered payload is refused before adapter invocation. Synchronous adapter throws, non-Effect returns, Effect defects, and malformed adapter results fail as typed `ADAPTER_RESULT_INVALID` errors. Provider output remains donor evidence; Generation cannot declare a Verified Candidate, perform Assembly, or write the application Run Record.
