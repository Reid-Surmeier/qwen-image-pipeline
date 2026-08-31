# Module map

<!-- Generated from modules/*/MODULE.md by scripts/generate_module_map.py. -->

| Module | Purpose | Interface | Errors | Acceptance |
| --- | --- | --- | --- | --- |
| Assembly | Deterministically combine authoritative baseline pixels, Exact Copy, and selected donor regions. | `modules/assembly/index.ts` | `modules/assembly/errors.ts` | `modules/assembly/assembly.test.ts` |
| Conductor | Give an application agent one normal planning path and one classified answer. | `modules/conductor/index.ts` | `modules/conductor/errors.ts` | `modules/conductor/conductor.test.ts` |
| Generation | Submit validated requests to the locked provider adapter and return normalized provider evidence and raw outputs. | `modules/generation/index.ts` | `modules/generation/errors.ts` | `modules/generation/generation.test.ts` |
| Learning Promotion | Convert completed application evidence into reviewable Learning Proposals without modifying live procedure rules. | `modules/learning-promotion/index.ts` | `modules/learning-promotion/errors.ts` | `modules/learning-promotion/learning-promotion.test.ts` |
| Reference Planning | Prove that authoritative application evidence is the exact media intended for the exact provider payload location. | `modules/reference-planning/index.ts` | `modules/reference-planning/errors.ts` | `modules/reference-planning/reference-planning.test.ts` |
| Release module | Turn one current independent build-line review into one immutable version tag and protected release. | `modules/release/interface.md` | `modules/release/errors.json` | `tests/test_release_governance.py` |
| Review | Bind independent review evidence to the exact candidate and contract. | `modules/review/interface.md` | `modules/review/errors.json` | `tests/test_successor_governance.py` |
| Run Contract | Turn valid planning documents and proved references into one canonical immutable Planned Run. | `modules/run-contract/index.ts` | `modules/run-contract/errors.ts` | `modules/run-contract/run-contract.test.ts` |
| Run Record | Record immutable requests, append-only chained events, durable attempt reservations, and write-once evidence for application runs. | `modules/run-record/index.ts` | `modules/run-record/errors.ts` | `modules/run-record/run-record.test.ts` |
| Testing | Prove the repository candidate through one deterministic, no-cost baseline. | `modules/testing/interface.md` | `modules/testing/errors.json` | `tests/test_deterministic_baseline.py`, `tests/test_successor_governance.py` |
| Verification | Enforce ordered verification stages (integrity, media/count, assembly/fidelity, deterministic gates, and human decision checkpoints). | `modules/verification/index.ts` | `modules/verification/errors.ts` | `modules/verification/verification.test.ts` |

The remaining Conductor-led modules named by Issue #17 are added by their implementation tickets; this map never claims an unimplemented module.
