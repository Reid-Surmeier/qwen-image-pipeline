# Provider Evidence Sanitizer

- Purpose: Classify provider evidence as unsafe before Generation can return it or Run Record can persist it.
- Interface: `modules/provider-evidence-sanitizer/index.ts`
- Errors: None; malformed or ambiguous evidence is conservatively classified as unsafe.
- Acceptance: `modules/provider-evidence-sanitizer/provider-evidence-sanitizer.test.ts`

This module owns the closed receipt schemas shared by both provider-facing persistence seams. Qwen completion identity, Qwen usage, Seedance submission, pending poll, and completed poll receipts each admit only their named fields and constrained values; unknown, inherited, symbol, non-enumerable, sparse, or throwing fields fail closed even when their contents use an encoding the diagnostic classifier does not understand. Completed Seedance receipts bind the closed dense output set, count, cost state, and an optional real UTC calendar timestamp.

The module also owns one credential classifier and one duplicate-JSON-key parser as defense-in-depth. They treat known Unicode disguises, serialized diagnostics, malformed embedded JSON, credential-bearing URLs, and loose field syntax as unsafe, but they are not the authority for persistence. Generation and Run Record translate all refusals into their own typed errors.
