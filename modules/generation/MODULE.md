# Generation

- Purpose: Prove the locked references reach the exact provider payload locations and invoke one normalized adapter through one Submission Permit.
- Interface: `modules/generation/index.ts`
- Errors: `modules/generation/errors.ts`
- Acceptance: `modules/generation/generation.test.ts`

Generation prepares a deterministic provider payload before reservation, verifies that each evidence media type equals the inspector-locked media type and matches its exact image or video payload location, and exposes the immutable request and payload SHA-256 values. Before consuming authority, invocation decodes every supplied reference from the payload, reconstructs the canonical payload from the immutable request, and requires exact equality; a self-consistent digest cannot hide a missing or substituted reference. Invocation then uses Run Record's runtime-authenticated, one-use Submission Permit bound to both digests. Synchronous adapter throws, non-Effect returns, Effect defects, and malformed adapter results fail as typed `ADAPTER_RESULT_INVALID` errors. Provider output remains donor evidence; Generation cannot declare a Verified Candidate, perform Assembly, or write the application Run Record.
