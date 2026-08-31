# Generation

- Purpose: Prove locked references reach exact provider payload locations, authorize one submission, and normalize Qwen or Seedance adapter evidence.
- Interface: `modules/generation/index.ts`
- Errors: `modules/generation/errors.ts`
- Acceptance: `modules/generation/generation.test.ts`, `modules/generation/inherited-qwen-adapter.test.ts`, `modules/generation/python-qwen-kernel-transport.test.ts`, `tests/test_qwen_adapter.py`, and `tests/test_qwen_adapter_host.py`

`inheritedQwenAdapter` is the version-1 language-neutral seam for the retained
Python Qwen kernel. It converts only the already-validated immutable Generation
payload into a closed JSON request, preserves the exact OpenRouter provider,
model, count, resolution, aspect ratio, seed, objective, reference roles, hashes, media types, bytes, and payload
destinations, and converts the kernel's closed response back into Generation
evidence. The Python kernel owns provider-specific request construction and PNG
normalization but owns no Run Record, retry, Assembly, Verification, or Approval.
`inheritedQwenPythonAdapter` is the repository-owned production transport. It
preflights the logical `OPENROUTER_API_KEY`, launches the fixed Python stdio host
without a shell, supplies only a narrow child environment, and never includes
stderr or provider exception text in typed evidence. Conductor and the one-use
Submission Permit remain the only normal submission authorization.
The production transport acceptance test executes the real Node-to-Python stdio
exchange with a malformed closed request and a fixture credential, so the host
refuses before provider dispatch. The deterministic ordinary-CI baseline skips
that provider-capable descendant while retaining OS network denial; the explicit
local acceptance command runs it without a provider request.

The shared Provider Evidence Sanitizer requires provider evidence to match the closed receipt schema for its exact stage before Generation can return it or pass recovery evidence to an adapter. It snapshots the closed evidence wrapper and copies its bytes before Generation validates or uses it. Recovery retains that private snapshot as the comparison oracle and gives the adapter a separate disposable copy, so adapter mutation cannot redefine the receipt being recovered. Unknown fields and wrapper accessors are refused, so persistence safety does not depend on recognizing every possible encoding of a diagnostic or credential. Its recursive credential and duplicate-key checks remain defense-in-depth.

Generation prepares a deterministic provider payload before reservation, verifies that each evidence media type equals the inspector-locked media type and matches its exact image or video payload location, and exposes the immutable request and payload SHA-256 values. Before consuming authority, invocation decodes every supplied reference from the payload, reconstructs the canonical payload from the immutable request, and requires exact equality; a self-consistent digest cannot hide a missing or substituted reference. Invocation then consumes Run Record's runtime-authenticated, one-use Submission Permit bound to both digests and only afterward invokes the adapter itself; no public Run Record operation can execute a caller-supplied submission Effect.

Qwen output is decoded and shape-checked as normalized RGBA before it can become donor evidence. The raster is a closed canonical document: its only keys are `height`, `pixels`, and `width`; duplicate keys, unknown fields, noncanonical key order, and insignificant whitespace are refused. Its complete output set must use unique canonical application paths and unique content SHA-256 identities; duplicates are malformed paid evidence and fail before any output persistence. `recover` gives that adapter the exact persisted provider response so it can reproduce outputs after a later persistence interruption without submitting again. `validatePersisted` applies the same no-adapter semantic validation when Conductor reconstructs a complete set from verified Run Record bytes. Seedance submission requires the immutable Video Plan and exact video payload, then returns one sanitized provider response bound to one job identity. Later Seedance polling accepts that exact response and job identity but no Submission Permit; pending and completed responses must preserve provider, model, identity, and status. Each poll observes the adapter method exactly once inside the guarded call path, so an accessor or Proxy cannot change between shape inspection and invocation. Raw provider JSON with duplicate object keys is refused before parsing, so an earlier secret or identity cannot be hidden by a later value. Adapter submission and poll results are copied once into guarded plain snapshots; validation and return never reread a stateful getter. A completed sanitized poll receipt must itself name the dense ordered output paths, media types, SHA-256 values, completed count, and cost state that Generation normalizes; an adapter cannot return a plausible body alongside a contradictory normalized success. Generation never treats adapter shape inspection as proof that submission did not start: a missing method, accessor, Proxy trap, synchronous throw, non-Effect return, Effect failure that claims `ADAPTER_NOT_STARTED`, unnamed failure, defect, throwing result accessor, substituted identity, or malformed evidence is `ADAPTER_RESULT_INVALID`, because observing or calling the untrusted adapter may already have produced an external effect. Recovery and polling have no unused submission capability and apply the same normalization to false pre-submit claims. Generation cannot declare a Verified Candidate, perform Assembly, verify output media, or write the application Run Record.

An adapter may return the typed `PROVIDER_AMBIGUOUS` failure when dispatch may have occurred but no trustworthy result arrived. That type guides the current control flow but is not durable evidence of the provider's cause. Once submission may have started, Run Record records only the evidence-backed `submission_unreconciled` fact, keeps the Run possibly spent and reconciliation-only, and never issues another Submission Permit for it.
