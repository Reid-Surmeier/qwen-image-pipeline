# Learning Promotion

- Purpose: Convert completed application evidence into reviewable Learning Proposals without modifying live procedure rules.
- Interface: `modules/learning-promotion/index.ts`
- Errors: `modules/learning-promotion/errors.ts`
- Acceptance: `modules/learning-promotion/learning-promotion.test.ts`

Learning Promotion reads completed evidence and creates an auditable Learning Proposal requiring both positive evidence and a caught counterexample. It cannot self-modify the live procedure.
