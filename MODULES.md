# Module map

<!-- Generated from modules/*/MODULE.md by scripts/generate_module_map.py. -->

| Module | Purpose | Interface | Errors | Acceptance |
| --- | --- | --- | --- | --- |
| Release module | Turn one current independent build-line review into one immutable version tag and protected release. | `modules/release/interface.md` | `modules/release/errors.json` | `tests/test_release_governance.py` |
| Review | Bind independent review evidence to the exact candidate and contract. | `modules/review/interface.md` | `modules/review/errors.json` | `tests/test_successor_governance.py` |
| Testing | Prove the repository candidate through one deterministic, no-cost baseline. | `modules/testing/interface.md` | `modules/testing/errors.json` | `tests/test_deterministic_baseline.py`, `tests/test_successor_governance.py` |

The remaining Conductor-led modules named by Issue #17 are added by their implementation tickets; this map never claims an unimplemented module.
