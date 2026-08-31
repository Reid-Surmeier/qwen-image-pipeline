# Verification

- Purpose: Run ordered deterministic checks and classify only an assembled artifact with proved pixel ownership as a Verified Candidate.
- Interface: `modules/verification/index.ts`
- Errors: `modules/verification/errors.ts`
- Acceptance: `modules/verification/verification.test.ts`

Verification checks integrity, media shape, outside-region preservation, and owned-region equality in that order. The owned-region oracle is the donor except at declared Exact Copy positions, where the hash-locked Exact Copy RGBA is authoritative. A raw generated donor cannot become a Verified Candidate when Assembly is required. Verification returns evidence and classification but never writes the Run Record or records subjective Approval.
