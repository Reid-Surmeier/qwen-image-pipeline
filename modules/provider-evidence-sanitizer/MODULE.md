# Provider Evidence Sanitizer

- Purpose: Classify provider evidence as unsafe before Generation can return it or Run Record can persist it.
- Interface: `modules/provider-evidence-sanitizer/index.ts`
- Errors: None; malformed or ambiguous evidence is conservatively classified as unsafe.
- Acceptance: `modules/provider-evidence-sanitizer/provider-evidence-sanitizer.test.ts`

This module owns one credential classifier and one duplicate-JSON-key parser for both provider-facing persistence seams. It treats Unicode disguises, serialized diagnostics, malformed embedded JSON, credential-bearing URLs, and loose field syntax as unsafe. Generation and Run Record still translate that classification into their own typed errors.

