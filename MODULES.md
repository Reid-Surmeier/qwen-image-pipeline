# Module map

<!-- Generated from modules/*/MODULE.md by scripts/generate_module_map.py. -->

| Module | Purpose | Interface | Errors | Acceptance |
| --- | --- | --- | --- | --- |
| Assembly | Deterministically compose a hash-locked donor and Exact Copy over a hash-locked baseline only inside the owned region. | `modules/assembly/index.ts` | `modules/assembly/errors.ts` | `modules/assembly/assembly.test.ts` |
| Conductor | Give an application agent one normal planning path and one classified answer. | `modules/conductor/index.ts` | `modules/conductor/errors.ts` | `modules/conductor/conductor.test.ts` and `modules/conductor/compatibility.test.ts` |
| Generation | Prove locked references reach exact provider payload locations, authorize one submission, and normalize Qwen or Seedance adapter evidence. | `modules/generation/index.ts` | `modules/generation/errors.ts` | `modules/generation/generation.test.ts` |
| Learning Promotion | Convert complete, generalized Run evidence into a review-only learning decision without self-modifying the tool. | `modules/learning-promotion/index.ts` | `modules/learning-promotion/errors.ts` | `modules/learning-promotion/learning-promotion.test.ts` |
| Provider Evidence Sanitizer | Classify provider evidence as unsafe before Generation can return it or Run Record can persist it. | `modules/provider-evidence-sanitizer/index.ts` | None; malformed or ambiguous evidence is conservatively classified as unsafe. | `modules/provider-evidence-sanitizer/provider-evidence-sanitizer.test.ts` |
| Reference Planning | Prove that authoritative application evidence is the exact media intended for the exact provider payload location. | `modules/reference-planning/index.ts` | `modules/reference-planning/errors.ts` | `modules/reference-planning/reference-planning.test.ts` |
| Release module | Turn one current independent build-line review into one immutable version tag and protected release. | `modules/release/interface.md` | `modules/release/errors.json` | `tests/test_release_governance.py` |
| Review | Bind independent review evidence to the exact candidate and contract. | `modules/review/index.ts`, `modules/review/interface.md` | `modules/review/errors.ts`, `modules/review/errors.json` | `modules/review/review-packet.test.ts`, `tests/test_successor_governance.py` |
| Run Contract | Turn valid planning documents and proved references into one canonical immutable Planned Run. | `modules/run-contract/index.ts` | `modules/run-contract/errors.ts` | `modules/run-contract/run-contract.test.ts` |
| Run Record | Own the immutable request, durable attempt reservation, hash-chained events, write-once evidence, and replay-derived view for one application Run. | `modules/run-record/index.ts` | `modules/run-record/errors.ts` | `modules/run-record/run-record.test.ts` |
| Testing | Prove the repository candidate through one deterministic, no-cost baseline. | `modules/testing/interface.md` | `modules/testing/errors.json` | `tests/test_deterministic_baseline.py`, `tests/test_successor_governance.py` |
| Verification | Run ordered deterministic checks and classify only an assembled artifact with proved pixel ownership as a Verified Candidate. | `modules/verification/index.ts` | `modules/verification/errors.ts` | `modules/verification/verification.test.ts` |
| Video Verification | Independently inspect completed Seedance bytes and prove their hash, media shape, duration, audio expectation, counts, and cost state before classification. | `modules/video-verification/index.ts` | `modules/video-verification/errors.ts` | `modules/video-verification/video-verification.test.ts` |

The remaining Conductor-led modules named by Issue #17 are added by their implementation tickets; this map never claims an unimplemented module.
