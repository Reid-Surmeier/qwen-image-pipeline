# Verification

- Purpose: Run ordered deterministic checks and classify only an assembled artifact with proved pixel ownership as a Verified Candidate.
- Interface: `modules/verification/index.ts`
- Errors: `modules/verification/errors.ts`
- Acceptance: `modules/verification/verification.test.ts`

Verification checks integrity, media shape, outside-region preservation, and owned-region equality in that order. The owned-region oracle is the donor except at declared Exact Copy positions, where safe-integer coordinates and exactly four hash-locked RGBA channels are authoritative. This interface is only for mandatory-Assembly candidates: it has no caller-controlled `assemblyRequired` switch, and a raw generated donor is rejected by its hash identity before fidelity classification. Verification returns the canonical Assembly report with its evidence and classification but never writes the Run Record or records subjective Approval.
