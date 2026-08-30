# Reference Planning

- Purpose: Prove that authoritative application evidence is the exact media intended for the exact provider payload location.
- Interface: `modules/reference-planning/index.ts`
- Errors: `modules/reference-planning/errors.ts`
- Acceptance: `modules/reference-planning/reference-planning.test.ts`

Reference Planning validates application-relative containment, authority reasons, declared and detected media kind, SHA-256, actual media properties, and locked JSON Pointer destinations. Hashing and inspection use the same byte snapshot. An image cannot satisfy a Seedance video requirement.
