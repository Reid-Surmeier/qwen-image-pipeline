# Verification

- Purpose: Enforce ordered verification stages (integrity, media/count, assembly/fidelity, deterministic gates, and human decision checkpoints).
- Interface: `modules/verification/index.ts`
- Errors: `modules/verification/errors.ts`
- Acceptance: `modules/verification/verification.test.ts`

Verification runs checks in mandatory sequence (integrity -> media/count -> assembly/fidelity -> deterministic -> semantic -> owner approval) and returns a classified outcome.
